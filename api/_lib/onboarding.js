// First-run onboarding (public/welcome.html): pick a persona, get a starter
// feed. aiConnected tells the feed whether to offer connecting an AI
// assistant (the connect card in vault.js). Routed through api/vault.js in production
// (resource=onboarding) to stay within the Vercel Hobby function limit.
//
//   GET    /api/onboarding          status + persona summaries
//   POST   /api/onboarding          { persona, timeZone } seeds the starter feed once
//   DELETE /api/onboarding/samples  soft-deletes the sample cards nobody touched
//
// State lives on the users row (onboarded_at, persona, sample_cards). Those
// columns arrive with a migration that runs after the deploy; until then
// onboarding switches itself off rather than failing sign-in or the vault.
const { getSql } = require('./db');
const { getSessionPayload } = require('./auth');
const { allowMethods, readJson, sendError } = require('./http');
const { limits, getCardUsage } = require('./limits');
const configs = require('./resource-configs');
const { findPersona, personaSummaries } = require('./onboarding-personas');

const EMPTY_PERSONA = 'empty';

function isMissingOnboardingColumns(error) {
  return /column "?(?:\w+\.)?(onboarded_at|persona|sample_cards)"? .*does not exist/.test(error?.message || '');
}

function requestError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

// Returns null when the migration hasn't run yet.
async function loadOnboardingRow(sql, email) {
  try {
    // created_with_onboarding: the account is younger than the first finished
    // onboarding, so it can't be one of the accounts from before onboarding
    // existed. Null (false) until someone has onboarded.
    const rows = await sql`
      select onboarded_at, persona, sample_cards,
        created_at >= (select min(onboarded_at) from users) as created_with_onboarding
      from users where email = ${email}
    `;
    return rows[0] || { onboarded_at: null, persona: null, sample_cards: [], created_with_onboarding: false };
  } catch (error) {
    if (isMissingOnboardingColumns(error)) return null;
    throw error;
  }
}

function asSampleList(value) {
  const list = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(list) ? list.filter(card => card && card.type && card.id) : [];
}

// ---- time zones -----------------------------------------------------------

function validTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(timeZone) });
    return String(timeZone);
  } catch (_) {
    return 'UTC';
  }
}

// Minutes east of UTC that `timeZone` is at `date`.
function zoneOffsetMinutes(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - date.getTime()) / 60000);
}

// The next moment the wall clock in `timeZone` reads `hhmm` ("07:00"), strictly
// after `now`. "Gym 7am" seeded at 9am falls due tomorrow at 7am, local time.
function nextOccurrence(hhmm, timeZone, now = new Date()) {
  const [hour, minute] = hhmm.split(':').map(Number);
  const offset = zoneOffsetMinutes(now, timeZone);
  const local = new Date(now.getTime() + offset * 60000);
  for (let dayShift = 0; dayShift <= 2; dayShift += 1) {
    const wallClock = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayShift, hour, minute);
    // Re-read the offset at the target moment so a DST change in between is honoured.
    const guess = new Date(wallClock - offset * 60000);
    const candidate = new Date(wallClock - zoneOffsetMinutes(guess, timeZone) * 60000);
    if (candidate > now) return candidate;
  }
  return new Date(now.getTime() + 24 * 60 * 60000);
}

// ---- cards ----------------------------------------------------------------

async function insertLearning(sql, tenant, card) {
  const existing = await sql`select coalesce(max(sort_order), -1) as max_sort_order from learning_entries where deleted_at is null and user_email = ${tenant} and category = ${card.category}`;
  const nextSortOrder = Number(existing[0]?.max_sort_order ?? -1) + 1;
  const rows = await sql`
    insert into learning_entries (user_email, title, url, notes, status, category, sort_order)
    values (${tenant}, ${card.title}, ${card.url || null}, ${card.notes || ''}, 'saved', ${card.category}, ${nextSortOrder})
    returning id
  `;
  return rows[0].id;
}

async function insertCard(sql, tenant, card, { timeZone, now }) {
  if (card.type === 'learning') return insertLearning(sql, tenant, card);
  const create = {
    reminder: () => configs.reminders.create(sql, tenant, {
      title: card.title, due_date: card.time ? nextOccurrence(card.time, timeZone, now).toISOString() : null, completed: false,
    }),
    work: () => configs.work.create(sql, tenant, { title: card.title, items: card.items.map(text => ({ text, completed: false })) }),
    family: () => configs.family.create(sql, tenant, { person: card.title, content: card.content || '' }),
    bookmark: () => configs.bookmarks.create(sql, tenant, { title: card.title, url: card.url || null, notes: card.notes || '', category: card.category }),
    talking_point: () => configs.talkingPoints.create(sql, tenant, { section_title: card.title, content: card.content, subsection_of: null }),
  }[card.type];
  const rows = await create();
  return rows[0].id;
}

async function seedPersona(sql, email, personaId, { timeZone = 'UTC', now = new Date() } = {}) {
  const persona = personaId === EMPTY_PERSONA ? null : findPersona(personaId);
  if (personaId !== EMPTY_PERSONA && !persona) throw requestError(400, 'Choose one of the listed personas.', 'UNKNOWN_PERSONA');
  try {
    await sql`insert into users (email) values (${email}) on conflict (email) do nothing`;
    // Claiming onboarded_at first makes a double-click or a retry a no-op:
    // only the request that flips it from null goes on to add cards.
    const claimed = await sql`update users set onboarded_at = now(), persona = ${personaId} where email = ${email} and onboarded_at is null returning email`;
    if (!claimed.length) return { seeded: 0, skipped: 0, alreadyOnboarded: true };
  } catch (error) {
    if (isMissingOnboardingColumns(error)) throw requestError(503, 'Onboarding is not available yet.', 'ONBOARDING_UNAVAILABLE');
    throw error;
  }
  const cards = persona?.cards || [];
  // Starter cards count toward the card limit like any other card; an account
  // near it gets as many as fit rather than an error.
  const usage = await getCardUsage(sql, email);
  const fitting = cards.slice(0, Math.max(0, limits.maxCardsPerUser - usage.cards));
  const zone = validTimeZone(timeZone);
  const created = [];
  for (const card of fitting) created.push({ type: card.type, id: await insertCard(sql, email, card, { timeZone: zone, now }) });
  await sql`update users set sample_cards = ${JSON.stringify(created)}::jsonb where email = ${email}`;
  return { seeded: created.length, skipped: cards.length - created.length, alreadyOnboarded: false };
}

// Sample cards that still exist, with what tells us whether the person has
// made them their own: an edit, a like or pin, or an attachment.
const SAMPLE_ROWS = {
  learning: (sql, tenant, ids) => sql`select id, created_at, updated_at from learning_entries where user_email = ${tenant} and deleted_at is null and id = any(${ids}::uuid[])`,
  reminder: (sql, tenant, ids) => sql`select id, created_at, updated_at from reminders where user_email = ${tenant} and deleted_at is null and id = any(${ids}::uuid[])`,
  work: (sql, tenant, ids) => sql`select id, created_at, updated_at from work_items where user_email = ${tenant} and deleted_at is null and id = any(${ids}::uuid[])`,
  family: (sql, tenant, ids) => sql`select id, created_at, updated_at from family_updates where user_email = ${tenant} and deleted_at is null and id = any(${ids}::uuid[])`,
  bookmark: (sql, tenant, ids) => sql`select id, created_at, updated_at from bookmarks where user_email = ${tenant} and deleted_at is null and id = any(${ids}::uuid[])`,
  talking_point: (sql, tenant, ids) => sql`select id, created_at, updated_at from talking_points where user_email = ${tenant} and deleted_at is null and id = any(${ids}::uuid[])`,
};
const REMOVE = {
  learning: (sql, tenant, id) => sql`update learning_entries set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning id`,
  reminder: (sql, tenant, id) => configs.reminders.remove(sql, tenant, id),
  work: (sql, tenant, id) => configs.work.remove(sql, tenant, id),
  family: (sql, tenant, id) => configs.family.remove(sql, tenant, id),
  bookmark: (sql, tenant, id) => configs.bookmarks.remove(sql, tenant, id),
  talking_point: (sql, tenant, id) => configs.talkingPoints.remove(sql, tenant, id),
};

async function liveSampleCards(sql, tenant, samples) {
  const live = [];
  for (const [type, query] of Object.entries(SAMPLE_ROWS)) {
    const ids = samples.filter(card => card.type === type).map(card => card.id);
    if (!ids.length) continue;
    // Inserts stamp created_at and updated_at together; every update re-stamps
    // updated_at (set_row_updated_at), so any difference means an edit.
    for (const row of await query(sql, tenant, ids)) live.push({ type, id: row.id, edited: new Date(row.updated_at) > new Date(row.created_at) });
  }
  if (!live.length) return live;
  const ids = live.map(card => card.id);
  const touched = new Set((await sql`
    select item_type || ':' || item_id as key from feed_state where user_email = ${tenant} and item_id = any(${ids}::uuid[]) and (liked_at is not null or pinned_at is not null)
    union select parent_type || ':' || parent_id from attachments where user_email = ${tenant} and deleted_at is null and parent_id = any(${ids}::uuid[])
  `).map(row => row.key));
  return live.map(card => ({ ...card, kept: card.edited || touched.has(`${card.type}:${card.id}`) }));
}

async function clearSampleCards(sql, email) {
  const row = await loadOnboardingRow(sql, email);
  if (!row) return { cleared: 0, kept: 0 };
  const live = await liveSampleCards(sql, email, asSampleList(row.sample_cards));
  const kept = live.filter(card => card.kept);
  for (const card of live.filter(card => !card.kept)) await REMOVE[card.type](sql, email, card.id);
  // Cards the person made their own stop being samples.
  await sql`update users set sample_cards = '[]'::jsonb where email = ${email}`;
  return { cleared: live.length - kept.length, kept: kept.length };
}

async function aiConnected(sql, email) {
  const rows = await sql`
    select exists(select 1 from oauth_refresh_tokens where user_email = ${email})
        or exists(select 1 from api_tokens where user_email = ${email} and revoked_at is null) as connected
  `;
  return rows[0]?.connected === true;
}

async function onboardingStatus(sql, email) {
  const row = await loadOnboardingRow(sql, email);
  const connected = await aiConnected(sql, email);
  if (!row) return { available: false, needsOnboarding: false, persona: null, sampleCount: 0, aiConnected: connected, personas: [] };
  const usage = await getCardUsage(sql, email);
  const samples = asSampleList(row.sample_cards);
  const sampleCount = samples.length ? (await liveSampleCards(sql, email, samples)).length : 0;
  return {
    available: true,
    // Accounts from before onboarding existed have cards and no onboarded_at,
    // and are never sent through it. A newer account may already have cards
    // without having onboarded: someone who signed up by connecting Claude or
    // ChatGPT (api/oauth.js) and saved cards there before opening the vault.
    needsOnboarding: !row.onboarded_at && (usage.cards === 0 || row.created_with_onboarding === true),
    cardCount: usage.cards,
    persona: row.persona || null,
    sampleCount,
    aiConnected: connected,
    personas: personaSummaries(),
  };
}

async function onboardingHandler(req, res) {
  const isSamples = req.query?.action === 'samples';
  if (!allowMethods(req, res, isSamples ? ['DELETE'] : ['GET', 'POST'])) return;
  const email = getSessionPayload(req)?.email;
  if (!email) return res.status(401).json({ error: 'Sign in to continue.', code: 'UNAUTHENTICATED' });
  try {
    const sql = getSql();
    if (isSamples) {
      req.cardleEvent = { type: 'onboarding.clear_samples' };
      return res.status(200).json(await clearSampleCards(sql, email));
    }
    if (req.method === 'GET') {
      req.cardleEvent = false;
      return res.status(200).json(await onboardingStatus(sql, email));
    }
    const body = await readJson(req);
    const persona = String(body.persona || '');
    req.cardleEvent = { type: 'onboarding.persona', context: { persona: persona.slice(0, 40) } };
    return res.status(200).json(await seedPersona(sql, email, persona, { timeZone: body.timeZone }));
  } catch (error) {
    return sendError(res, error);
  }
}

const removeCard = (sql, tenant, type, id) => REMOVE[type](sql, tenant, id);

// insertCard, liveSampleCards and removeCard are shared with "Deal me 5"
// (surprise.js), whose dealt cards are kept or cleared by the same rules.
module.exports = { onboardingHandler, onboardingStatus, seedPersona, clearSampleCards, nextOccurrence, insertCard, liveSampleCards, removeCard, EMPTY_PERSONA };
