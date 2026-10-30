const { getSql } = require('./db');
const { resolveViewerTenant, resolveWriterTenant } = require('./auth');
const { allowMethods, readJson, sendError } = require('./http');
const { purgeAttachments } = require('./attachments');
const { LimitError, assertCardCreateAllowed, assertCardUpdateAllowed } = require('./limits');

function clean(value) { return String(value ?? '').trim(); }
function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return Boolean(value);
}
function json(value, fallback = []) {
  if (value === undefined) return fallback;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return null; } }
  return value;
}

// Dates arrive from people's AI assistants as much as from the date picker,
// so only unambiguous forms are accepted: a calendar day, or a timestamp that
// says its time zone. `new Date()` alone would turn "tomorrow" into a raw
// RangeError, roll 2026-02-30 over to March 2, read "0" as the year 2000, and
// read 09:00 without a zone in the server's zone (UTC on Vercel) rather than
// the person's.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
function realCalendarDay(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day);
}
function parseDateInput(value, name = 'date') {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  const day = DATE_ONLY.exec(text);
  if (day) {
    if (!realCalendarDay(day[1], day[2], day[3])) throw new Error(`Invalid ${name}: ${text} is not a real calendar date`);
    return new Date(`${text}T00:00:00Z`).toISOString();
  }
  const stamp = DATE_TIME.exec(text);
  if (!stamp) throw new Error(`Invalid ${name}: use a date like 2026-10-05 or a timestamp with its time zone, like 2026-10-05T09:00:00+05:30`);
  const [, year, month, date, hour, minute, second = '0', zone] = stamp;
  if (!realCalendarDay(year, month, date) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    throw new Error(`Invalid ${name}: ${text} is not a real date and time`);
  }
  if (!zone) throw new Error(`Invalid ${name}: ${text} has no time zone. Add the person's offset, e.g. ${text}+05:30, or Z for UTC`);
  return new Date(text.replace(' ', 'T')).toISOString();
}

// Links are rendered as clickable links in the vault, so only web links (or a
// bare address like example.com, which the vault treats as text) are kept.
// A javascript: or data: "link" would run in the vault when clicked.
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i;
function checkLinkUrl(value, name = 'url') {
  const text = clean(value);
  if (!text) return null;
  // Browsers drop tabs, newlines and other control characters while parsing
  // a link, so "java\tscript:" and "\x01javascript:" still run script.
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`Invalid ${name}: links can't contain control characters`);
  const scheme = URL_SCHEME.exec(text);
  // "example.com:8080/x" and "localhost:3000" are an address and a port.
  const hostAndPort = scheme && /^(localhost|.+\..+)$/i.test(scheme[1]) && /^\d+(\/|$)/.test(text.slice(scheme[0].length));
  if (scheme && !hostAndPort && !['http', 'https'].includes(scheme[1].toLowerCase())) {
    throw new Error(`Invalid ${name}: only http and https links can be saved`);
  }
  return text;
}

// A work card's checklist: each entry is { text, completed }. The vault's
// Work tab sends one plain string per line, so strings become entries too;
// blank lines are dropped rather than saved as empty checklist items.
function checklist(value) {
  if (!Array.isArray(value)) return value;
  const items = [];
  for (const entry of value) {
    const isObject = entry && typeof entry === 'object' && !Array.isArray(entry);
    const text = clean(isObject ? entry.text : entry);
    if (!text) {
      if (isObject && entry.text !== undefined && typeof entry.text !== 'string') throw new Error('Invalid items: each checklist entry needs text');
      continue;
    }
    if (isObject) {
      items.push({ ...entry, text, completed: toBool(entry.completed ?? entry.done ?? entry.checked ?? false) });
    } else {
      // Marked (invisibly: it isn't saved) so an update can keep the ticks of
      // lines that were already on the card -- the Work tab sends only text.
      const item = { text, completed: false };
      Object.defineProperty(item, 'fromLine', { value: true });
      items.push(item);
    }
  }
  return items;
}

function validate(body, config, creating) {
  const result = {};
  for (const field of config.fields) {
    if (!creating && !(field.name in body)) continue;
    // Apply defaults before enum validation so omitted optional fields such as a
    // bookmark category use their documented default instead of failing 400.
    let value = body[field.name];
    if (value === undefined) value = field.default;
    if (field.kind === 'string') value = clean(value);
    if (field.kind === 'nullableString') value = clean(value) || null;
    // Words that mean "no value", e.g. recurrence: 'none'.
    if (field.nullAliases?.includes(value)) value = null;
    if (field.kind === 'boolean') value = toBool(value);
    if (field.kind === 'date') value = parseDateInput(value, field.name);
    if (field.link) value = checkLinkUrl(value, field.name);
    if (field.kind === 'json') value = json(value, field.default);
    if (field.required && !value) throw new Error(`${field.label || field.name} is required`);
    if (field.values && !field.values.includes(value)) throw new Error(`Invalid ${field.name}`);
    if (field.kind === 'json' && !Array.isArray(value)) throw new Error(`${field.name} must be an array`);
    if (field.checklist) value = checklist(value);
    result[field.name] = value === undefined ? field.default : value;
  }
  return result;
}
// For the event log (events.js): which fields a write touched, plus the
// values of the ones that are categories or flags (status, category,
// completed...) -- the signal a recommender can use. Free text stays out.
function describeValues(values, config) {
  const context = { fields: Object.keys(values) };
  for (const field of config.fields) {
    if (field.name in values && (field.values || field.kind === 'boolean')) context[field.name] = values[field.name];
  }
  return context;
}
function statusFor(error) {
  if (error instanceof LimitError || error.status) return error.status;
  if (/required|Invalid|must be/.test(error.message)) {
    error.status = 400;
    error.code = 'VALIDATION_ERROR';
    return 400;
  }
  if (error.code === '23505') {
    error.status = 409;
    error.code = 'DUPLICATE_ITEM';
    error.message = 'An item with those values already exists.';
    return 409;
  }
  return 500;
}
function collection(config) {
  return async function handler(req, res) {
    if (!allowMethods(req, res, ['GET', 'POST'])) return;
    try {
      if (req.method === 'GET') {
        const sql = getSql();
        const tenant = resolveViewerTenant(req);
        return res.status(200).json({ [config.plural]: await config.list(sql, tenant) });
      }
      const tenant = resolveWriterTenant(req);
      if (!tenant) return res.status(401).json({ error: 'Authentication required' });
      const sql = getSql();
      // Optional per-resource hook (e.g. kanban blocks manual creates while
      // GitHub-synced); every other resource leaves this unset and is unaffected.
      if (config.guardCreate && !(await config.guardCreate(req, res, sql, tenant))) return;
      const body = await readJson(req);
      const values = validate(body, config, true);
      await assertCardCreateAllowed(sql, tenant, config.feedType, values);
      const rows = await config.create(sql, tenant, values);
      req.cardleEvent = { type: 'card.create', item_type: config.feedType, item_id: rows[0]?.id, context: describeValues(values, config) };
      return res.status(201).json({ [config.singular]: rows[0] });
    } catch (error) { return sendError(res, error, statusFor(error)); }
  };
}
function item(config) {
  return async function handler(req, res) {
    if (!allowMethods(req, res, ['PATCH', 'DELETE'])) return;
    const tenant = resolveWriterTenant(req);
    if (!tenant) return res.status(401).json({ error: 'Authentication required' });
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'Item id is required' });
    try {
      const sql = getSql();
      // Optional per-resource hook; see guardCreate above.
      if (config.guardMutate && !(await config.guardMutate(req, res, id, sql, tenant))) return;
      if (req.method === 'DELETE') {
        const rows = await config.remove(sql, tenant, id);
        if (!rows.length) return res.status(404).json({ error: 'Item not found' });
        if (config.feedType) await purgeAttachments(sql, tenant, config.feedType, id);
        req.cardleEvent = { type: 'card.delete', item_type: config.feedType, item_id: id };
        return res.status(200).json({ [config.singular]: rows[0] });
      }
      const body = await readJson(req);
      const values = validate(body, config, false);
      await assertCardUpdateAllowed(sql, tenant, config.feedType, id, values);
      const rows = await config.update(sql, tenant, id, values);
      if (!rows.length) return res.status(404).json({ error: 'Item not found' });
      req.cardleEvent = { type: 'card.update', item_type: config.feedType, item_id: id, context: describeValues(values, config) };
      return res.status(200).json({ [config.singular]: rows[0] });
    } catch (error) { return sendError(res, error, statusFor(error)); }
  };
}
module.exports = { collection, item, validate, statusFor, parseDateInput, checkLinkUrl, checklist };
