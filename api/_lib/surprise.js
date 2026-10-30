// "Deal me 5": one tap adds five fresh, mostly educational cards to a thin
// feed -- four videos or articles from the topics the person picked, plus one
// small thing to try. Routed through api/vault.js in production
// (resource=surprise) to stay within the Vercel Hobby function limit.
//
//   GET  /api/surprise   topics, deals left today, and cards still on trial
//   POST /api/surprise   { topics? } saves the topics if given, then deals
//
// Cards come from a shared pool of the newest items from the sources in
// surprise-sources.js, refreshed at most every REFRESH_HOURS by whichever
// request finds it stale (no cron: Vercel Hobby allows only daily ones, and
// they need a secret). Dealt cards -- and a new account's starter cards -- are
// on trial: still untouched after TRIAL_DAYS, they are removed, so a feed
// never fills up with stale news nobody read. A new deal adds to the last
// one rather than replacing it: the feed says each card has TRIAL_DAYS, and
// with the button always in the header a second tap shouldn't cost someone
// cards they haven't read yet. DEALS_PER_DAY and the card limit bound the growth.
const crypto = require('crypto');
const { getSql } = require('./db');
const { getSessionPayload } = require('./auth');
const { allowMethods, readJson, sendError } = require('./http');
const { limits, getCardUsage } = require('./limits');
const { publicOrigin } = require('./public-origin');
const { insertCard, liveSampleCards, removeCard, clearSampleCards } = require('./onboarding');
const { TOPICS, TOPIC_IDS, SOURCES, EVERGREEN, CHALLENGES, PERSONA_TOPICS } = require('./surprise-sources');

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 14;
const DEALS_PER_DAY = 3;
const LEARNINGS_PER_DEAL = 4;
const FRESH_DAYS = 90;
const REFRESH_HOURS = 12;
const FETCH_TIMEOUT_MS = 4000;
// Items older than this are dropped from the shared pool, which holds nobody's data.
const POOL_KEEP_DAYS = 180;

function requestError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

// Until the migration runs, "Deal me 5" hides itself rather than failing.
function isMissingSurpriseSchema(error) {
  return /column "?(?:\w+\.)?(interests|last_deal_at|onboarded_at|persona|sample_cards)"? .*does not exist|relation "?surprise_\w+"? does not exist/.test(error?.message || '');
}

const daysAgo = days => new Date(Date.now() - days * DAY_MS).toISOString();
const plusDays = (date, days) => new Date(new Date(date).getTime() + days * DAY_MS).toISOString();

function asList(value) {
  const list = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(list) ? list : null;
}

// ---- the shared pool ------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity) => {
      if (entity[0] !== '#') return ENTITIES[entity] ?? match;
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagText(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return match ? decodeXml(match[1]) : '';
}

function entryLink(block) {
  for (const [tag] of block.matchAll(/<link\b[^>]*>/g)) {
    const href = tag.match(/\bhref="([^"]+)"/)?.[1];
    const rel = tag.match(/\brel="([^"]+)"/)?.[1];
    if (href && (!rel || rel === 'alternate')) return decodeXml(href);
  }
  return tagText(block, 'link');
}

// Atom (YouTube, most blogs) and RSS 2.0 entries, newest first. Shorts are
// skipped: a feed card wants something worth sitting down for.
function parseFeed(xml, source) {
  const items = [];
  for (const [block] of String(xml || '').matchAll(/<(entry|item)[\s>][\s\S]*?<\/\1>/g)) {
    const link = entryLink(block);
    if (/youtube\.com\/shorts\//.test(link)) continue;
    const videoId = tagText(block, 'yt:videoId');
    const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : link;
    const title = tagText(block, 'title').slice(0, limits.maxTitleChars);
    const published = Date.parse(tagText(block, 'published') || tagText(block, 'pubDate') || tagText(block, 'updated'));
    if (!title || !/^https:\/\/[^\s]+$/.test(url) || url.length > limits.maxUrlChars || !Number.isFinite(published)) continue;
    items.push({ key: `${source.id}:${videoId || url}`, sourceId: source.id, topic: source.topic, title, url, publishedAt: new Date(published).toISOString() });
  }
  return items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

async function fetchSource(sql, source) {
  try {
    const response = await fetch(source.feed, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': `Cardlake/1.0 (+${publicOrigin()})` } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const fresh = parseFeed(await response.text(), source).filter(item => item.publishedAt > daysAgo(FRESH_DAYS));
    if (fresh.length) {
      await sql`
        insert into surprise_pool (key, source_id, topic, title, url, published_at)
        select * from unnest(${fresh.map(i => i.key)}::text[], ${fresh.map(i => i.sourceId)}::text[], ${fresh.map(i => i.topic)}::text[],
                             ${fresh.map(i => i.title)}::text[], ${fresh.map(i => i.url)}::text[], ${fresh.map(i => i.publishedAt)}::timestamptz[])
        on conflict (key) do nothing
      `;
    }
    await sql`update surprise_sources set ok_at = now(), last_error = null where id = ${source.id}`;
    return fresh.length;
  } catch (error) {
    // One broken feed never stops the others; it is retried on the next refresh.
    await sql`update surprise_sources set last_error = ${String(error.message || error).slice(0, 200)} where id = ${source.id}`;
    return null;
  }
}

// Fetches every source not checked in the last REFRESH_HOURS. Claiming a
// source (checked_at) before fetching it means concurrent requests never
// fetch the same feed twice. Cheap -- one query -- when nothing is stale.
async function refreshPool(sql) {
  const ids = SOURCES.map(source => source.id);
  await sql`insert into surprise_sources (id) select unnest(${ids}::text[]) on conflict (id) do nothing`;
  const claimed = new Set((await sql`
    update surprise_sources set checked_at = now()
    where id = any(${ids}::text[]) and checked_at < ${new Date(Date.now() - REFRESH_HOURS * 3600e3).toISOString()}::timestamptz
    returning id
  `).map(row => row.id));
  if (!claimed.size) return { checked: 0, added: 0, failed: 0 };
  const results = await Promise.all(SOURCES.filter(source => claimed.has(source.id)).map(source => fetchSource(sql, source)));
  await sql`delete from surprise_pool where published_at < ${daysAgo(POOL_KEEP_DAYS)}::timestamptz`;
  return { checked: results.length, added: results.reduce((sum, n) => sum + (n || 0), 0), failed: results.filter(n => n === null).length };
}

// ---- choosing a deal --------------------------------------------------------

const sourceName = id => SOURCES.find(source => source.id === id)?.name || '';

// Up to `count` unseen items, spread across the chosen topics in turn and at
// most one per source, so a deal is varied. Short of that, it relaxes the
// one-per-source rule, then borrows from other topics, then falls back to the
// evergreen list.
function pickLearnings(pool, seen, topics, count) {
  const unseen = pool.filter(item => !seen.has(item.key));
  const evergreen = EVERGREEN.filter(item => !seen.has(item.key));
  const picked = [];
  const taken = new Set();
  const usedSources = new Set();
  const add = item => { picked.push(item); taken.add(item.key); usedSources.add(item.source_id || item.key); };
  const roundRobin = (lists, oncePerSource) => {
    let progress = true;
    while (picked.length < count && progress) {
      progress = false;
      for (const list of lists) {
        if (picked.length >= count) break;
        const next = list.find(item => !taken.has(item.key) && (!oncePerSource || !usedSources.has(item.source_id)));
        if (next) { add(next); progress = true; }
      }
    }
  };
  const chosen = unseen.filter(item => topics.includes(item.topic));
  const byTopic = topics.map(topic => chosen.filter(item => item.topic === topic));
  roundRobin(byTopic, true);
  roundRobin(byTopic, false);
  roundRobin([unseen.filter(item => !topics.includes(item.topic))], true);
  roundRobin([evergreen.filter(item => topics.includes(item.topic))], false);
  roundRobin([evergreen], false);
  return picked;
}

function pickChallenge(seen, topics) {
  const unseen = CHALLENGES.filter(item => !seen.has(item.key));
  const preferred = unseen.filter(item => topics.includes(item.topic));
  const from = preferred.length ? preferred : unseen;
  return from.length ? from[Math.floor(Math.random() * from.length)] : null;
}

function learningCard(item) {
  const from = item.source || sourceName(item.source_id);
  return { type: 'learning', title: item.title, url: item.url, notes: from ? `From ${from}.` : '', category: item.topic === 'ai' ? 'ai' : 'others' };
}

async function seenKeys(sql, email) {
  return new Set((await sql`select item_key from surprise_deals where user_email = ${email}`).map(row => row.item_key));
}

async function freshPool(sql) {
  return sql`select key, source_id, topic, title, url from surprise_pool where published_at > ${daysAgo(FRESH_DAYS)}::timestamptz order by published_at desc, key`;
}

async function dealsToday(sql, email) {
  const rows = await sql`select count(distinct deal_id)::int as count from surprise_deals where user_email = ${email} and dealt_at > ${daysAgo(1)}::timestamptz`;
  return rows[0]?.count || 0;
}

// ---- trials: dealt and starter cards that go unless someone keeps them -------

// Settles deals whose trial is over: a card someone liked, pinned, edited or
// attached a file to is theirs for good; an untouched one is removed.
async function settleDueDeals(sql, email) {
  const open = await sql`select id, item_type, item_id from surprise_deals where user_email = ${email} and settled_at is null and dealt_at < ${daysAgo(TRIAL_DAYS)}::timestamptz`;
  if (!open.length) return { removed: 0, kept: 0 };
  const live = new Map((await liveSampleCards(sql, email, open.map(row => ({ type: row.item_type, id: row.item_id }))))
    .map(card => [`${card.type}:${card.id}`, card]));
  let removed = 0;
  let kept = 0;
  for (const row of open) {
    const card = live.get(`${row.item_type}:${row.item_id}`);
    const outcome = !card ? 'deleted' : card.kept ? 'kept' : 'expired';
    if (outcome === 'expired') { await removeCard(sql, email, row.item_type, row.item_id); removed += 1; }
    if (outcome === 'kept') kept += 1;
    await sql`update surprise_deals set settled_at = now(), outcome = ${outcome} where id = ${row.id} and user_email = ${email}`;
  }
  return { removed, kept };
}

// Called when someone opens their feed: removes dealt and starter cards whose
// trial is over. Never lets a failure (or a missing migration) break the feed.
async function sweepTrials(sql, email) {
  try {
    await settleDueDeals(sql, email);
    const due = await sql`select 1 from users where email = ${email} and onboarded_at < ${daysAgo(TRIAL_DAYS)}::timestamptz and jsonb_array_length(sample_cards) > 0`;
    if (due.length) await clearSampleCards(sql, email);
  } catch (error) {
    if (!isMissingSurpriseSchema(error)) console.error('Could not sweep trial cards', error.message);
  }
}

// Cards still on trial, with when each goes, so the feed can say so.
async function trialCards(sql, email, row) {
  const open = await sql`select item_type, item_id, dealt_at from surprise_deals where user_email = ${email} and settled_at is null`;
  const samples = row.onboarded_at ? (asList(row.sample_cards) || []) : [];
  const expiresAt = new Map([
    ...open.map(deal => [`${deal.item_type}:${deal.item_id}`, { kind: 'dealt', expiresAt: plusDays(deal.dealt_at, TRIAL_DAYS) }]),
    ...samples.map(card => [`${card.type}:${card.id}`, { kind: 'sample', expiresAt: plusDays(row.onboarded_at, TRIAL_DAYS) }]),
  ]);
  if (!expiresAt.size) return [];
  const all = [...expiresAt.keys()].map(key => { const [type, id] = key.split(':'); return { type, id }; });
  return (await liveSampleCards(sql, email, all)).filter(card => !card.kept)
    .map(card => ({ type: card.type, id: card.id, ...expiresAt.get(`${card.type}:${card.id}`) }));
}

// ---- the endpoints --------------------------------------------------------

async function loadDealRow(sql, email) {
  try {
    const rows = await sql`select persona, interests, onboarded_at, sample_cards from users where email = ${email}`;
    return rows[0] || { persona: null, interests: null, onboarded_at: null, sample_cards: [] };
  } catch (error) {
    if (isMissingSurpriseSchema(error)) return null;
    throw error;
  }
}

async function surpriseStatus(sql, email) {
  const row = await loadDealRow(sql, email);
  if (!row) return { available: false };
  try {
    await refreshPool(sql);
    const seen = await seenKeys(sql, email);
    const unseen = (await freshPool(sql)).filter(item => !seen.has(item.key)).length + EVERGREEN.filter(item => !seen.has(item.key)).length;
    const dealt = await dealsToday(sql, email);
    return {
      available: true,
      topics: TOPICS,
      interests: asList(row.interests),
      suggestedTopics: PERSONA_TOPICS[row.persona] || [],
      dealsPerDay: DEALS_PER_DAY,
      dealsLeftToday: Math.max(0, DEALS_PER_DAY - dealt),
      unseen,
      trialDays: TRIAL_DAYS,
      trials: await trialCards(sql, email, row),
    };
  } catch (error) {
    if (isMissingSurpriseSchema(error)) return { available: false };
    throw error;
  }
}

function parseTopics(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw requestError(400, 'topics must be a list.', 'INVALID_TOPICS');
  return [...new Set(value.map(String))].filter(topic => TOPIC_IDS.includes(topic));
}

async function deal(sql, email, body) {
  const requested = parseTopics(body.topics);
  const row = await loadDealRow(sql, email);
  if (!row) throw requestError(503, 'Deal me 5 is not available yet.', 'SURPRISE_UNAVAILABLE');
  await sql`insert into users (email) values (${email}) on conflict (email) do nothing`;
  if (requested !== undefined) await sql`update users set interests = ${JSON.stringify(requested)}::jsonb where email = ${email}`;
  const saved = requested ?? asList(row.interests) ?? [];
  // No topics picked means "surprise me": every topic.
  const topics = saved.length ? saved : TOPIC_IDS;

  if (await dealsToday(sql, email) >= DEALS_PER_DAY) throw requestError(429, 'That’s all your deals for today. Come back tomorrow for more.', 'DEAL_LIMIT');
  // A double tap, or a retry while the first request is still running, deals once.
  const claimed = await sql`update users set last_deal_at = now() where email = ${email} and (last_deal_at is null or last_deal_at < now() - interval '15 seconds') returning email`;
  if (!claimed.length) throw requestError(409, 'Already dealing your cards.', 'DEAL_IN_PROGRESS');

  await refreshPool(sql);
  const seen = await seenKeys(sql, email);
  const learnings = pickLearnings(await freshPool(sql), seen, topics, LEARNINGS_PER_DEAL);
  const challenge = pickChallenge(seen, topics);
  const picks = [
    ...learnings.map(item => ({ key: item.key, card: learningCard(item) })),
    ...(challenge ? [{ key: challenge.key, card: { type: 'reminder', title: challenge.title, time: null } }] : []),
  ];
  if (!picks.length) throw requestError(409, 'You’ve seen every card we have. New ones arrive every day.', 'NOTHING_LEFT');

  // Clear anything past its trial first, so it doesn't count against the card limit.
  await settleDueDeals(sql, email);
  const room = limits.maxCardsPerUser - (await getCardUsage(sql, email)).cards;
  if (room <= 0) throw requestError(409, 'Your feed is at its card limit. Delete a few cards to make room.', 'CARD_LIMIT');

  const dealId = crypto.randomUUID();
  const cards = [];
  for (const pick of picks.slice(0, room)) {
    const id = await insertCard(sql, email, pick.card, { timeZone: 'UTC', now: new Date() });
    await sql`insert into surprise_deals (user_email, deal_id, item_key, item_type, item_id) values (${email}, ${dealId}, ${pick.key}, ${pick.card.type}, ${id})`;
    cards.push({ type: pick.card.type, id, title: pick.card.title });
  }
  return { dealt: cards.length, cards, topics, dealsLeftToday: Math.max(0, DEALS_PER_DAY - await dealsToday(sql, email)) };
}

async function surpriseHandler(req, res) {
  if (!allowMethods(req, res, ['GET', 'POST'])) return;
  const email = getSessionPayload(req)?.email;
  if (!email) return res.status(401).json({ error: 'Sign in to continue.', code: 'UNAUTHENTICATED' });
  try {
    const sql = getSql();
    if (req.method === 'GET') {
      req.cardleEvent = false;
      return res.status(200).json(await surpriseStatus(sql, email));
    }
    const body = await readJson(req);
    req.cardleEvent = { type: 'surprise.deal', context: { topics_saved: body.topics !== undefined } };
    const result = await deal(sql, email, body);
    req.cardleEvent.context = { ...req.cardleEvent.context, topics: result.topics, count: result.dealt };
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error);
  }
}

module.exports = { surpriseHandler, surpriseStatus, deal, refreshPool, parseFeed, pickLearnings, sweepTrials, TRIAL_DAYS, DEALS_PER_DAY };
