// Central, server-authoritative limits. Keep defaults conservative enough for
// Vercel Functions and a small production Neon/Blob deployment; every value
// can be changed per environment without a code deploy.
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function positiveInt(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const limits = Object.freeze({
  maxCardsPerUser: positiveInt('CARDLE_MAX_CARDS_PER_USER', 500),
  maxTextBytesPerUser: positiveInt('CARDLE_MAX_TEXT_BYTES_PER_USER', 2 * MiB),
  maxAttachmentsPerCard: positiveInt('CARDLE_MAX_ATTACHMENTS_PER_CARD', 5),
  maxFileBytes: positiveInt('CARDLE_MAX_FILE_BYTES', 4 * MiB),
  maxFileBytesPerUser: positiveInt('CARDLE_MAX_FILE_BYTES_PER_USER', 50 * MiB),
  maxUploadsPerDay: positiveInt('CARDLE_MAX_UPLOADS_PER_DAY', 20),
  maxFilenameChars: positiveInt('CARDLE_MAX_FILENAME_CHARS', 128),
  maxTitleChars: positiveInt('CARDLE_MAX_TITLE_CHARS', 200),
  maxContentChars: positiveInt('CARDLE_MAX_CONTENT_CHARS', 50000),
  maxUrlChars: positiveInt('CARDLE_MAX_URL_CHARS', 2048),
  maxWorkItems: positiveInt('CARDLE_MAX_WORK_ITEMS', 100),
  maxJsonBodyBytes: positiveInt('CARDLE_MAX_JSON_BODY_BYTES', 256 * 1024),
  blobStorageAlertBytes: positiveInt('CARDLE_BLOB_STORAGE_ALERT_BYTES', 20 * GiB),
  blobStorageHardLimitBytes: positiveInt('CARDLE_BLOB_STORAGE_HARD_LIMIT_BYTES', 30 * GiB),
});

class LimitError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'LimitError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function limitError(status, code, message, used, limit, extra = {}) {
  return new LimitError(status, code, message, { used, limit, remaining: Math.max(0, limit - used), ...extra });
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function textBytesForCard(type, value = {}) {
  const fields = {
    learning: ['title', 'url', 'notes'],
    kanban: ['title', 'asin', 'description', 'source'],
    work: ['title', 'items'],
    family: ['person', 'content'],
    bookmark: ['title', 'url', 'notes'],
    talking_point: ['section_title', 'content', 'subsection_of'],
    reminder: ['title'],
    file: ['name'],
  }[type] || [];
  return fields.reduce((total, field) => {
    const valueForField = field === 'items' && typeof value[field] !== 'string'
      ? JSON.stringify(value[field] || [])
      : value[field];
    return total + byteLength(valueForField);
  }, 0);
}

function assertInputLimits(type, values) {
  const titleFields = ['title', 'person', 'section_title'];
  const contentFields = ['notes', 'description', 'content'];
  for (const field of titleFields) {
    if (Object.prototype.hasOwnProperty.call(values, field) && String(values[field] ?? '').length > limits.maxTitleChars) {
      throw limitError(413, 'TITLE_TOO_LONG', `Title must be ${limits.maxTitleChars} characters or fewer.`, String(values[field]).length, limits.maxTitleChars, { field });
    }
  }
  for (const field of contentFields) {
    if (Object.prototype.hasOwnProperty.call(values, field) && String(values[field] ?? '').length > limits.maxContentChars) {
      throw limitError(413, 'CONTENT_TOO_LONG', `Text must be ${limits.maxContentChars.toLocaleString()} characters or fewer.`, String(values[field]).length, limits.maxContentChars, { field });
    }
  }
  for (const field of ['url', 'source', 'asin', 'subsection_of']) {
    if (Object.prototype.hasOwnProperty.call(values, field) && String(values[field] ?? '').length > limits.maxUrlChars) {
      throw limitError(413, 'FIELD_TOO_LONG', `${field.replace(/_/g, ' ')} must be ${limits.maxUrlChars.toLocaleString()} characters or fewer.`, String(values[field]).length, limits.maxUrlChars, { field });
    }
  }
  if (type === 'work' && Object.prototype.hasOwnProperty.call(values, 'items')) {
    if (!Array.isArray(values.items)) throw new LimitError(400, 'INVALID_WORK_ITEMS', 'Work checklist items must be an array.');
    if (values.items.length > limits.maxWorkItems) {
      throw limitError(413, 'TOO_MANY_WORK_ITEMS', `A work card can have at most ${limits.maxWorkItems} checklist items.`, values.items.length, limits.maxWorkItems, { field: 'items' });
    }
  }
}

async function getCardRow(sql, tenant, type, id, includeDeleted = false) {
  const queries = {
    learning: () => sql`select * from learning_entries where id = ${id} and user_email = ${tenant} and (deleted_at is null or ${includeDeleted}) limit 1`,
    kanban: () => sql`select * from kanban_items where id = ${id} and user_email = ${tenant} and (deleted_at is null or ${includeDeleted}) limit 1`,
    work: () => sql`select * from work_items where id = ${id} and user_email = ${tenant} and (deleted_at is null or ${includeDeleted}) limit 1`,
    family: () => sql`select * from family_updates where id = ${id} and user_email = ${tenant} and (deleted_at is null or ${includeDeleted}) limit 1`,
    bookmark: () => sql`select * from bookmarks where id = ${id} and user_email = ${tenant} and (deleted_at is null or ${includeDeleted}) limit 1`,
    reminder: () => sql`select * from reminders where id = ${id} and user_email = ${tenant} and (deleted_at is null or ${includeDeleted}) limit 1`,
    talking_point: () => sql`select * from talking_points where id = ${id} and user_email = ${tenant} and (deleted_at is null or ${includeDeleted}) limit 1`,
  };
  const rows = queries[type] ? await queries[type]() : [];
  return rows[0] || null;
}

async function getCardUsage(sql, tenant) {
  const rows = await sql`
    select count(*)::int as count, coalesce(sum(text_bytes), 0)::bigint as text_bytes from (
      select octet_length(coalesce(title, '')) + octet_length(coalesce(url, '')) + octet_length(coalesce(notes, '')) as text_bytes from learning_entries where user_email = ${tenant} and deleted_at is null
      union all select octet_length(coalesce(title, '')) + octet_length(coalesce(asin, '')) + octet_length(coalesce(description, '')) + octet_length(coalesce(source, '')) from kanban_items where user_email = ${tenant} and deleted_at is null
      union all select octet_length(coalesce(title, '')) + octet_length(coalesce(items::text, '')) from work_items where user_email = ${tenant} and deleted_at is null
      union all select octet_length(coalesce(person, '')) + octet_length(coalesce(content, '')) from family_updates where user_email = ${tenant} and deleted_at is null
      union all select octet_length(coalesce(title, '')) + octet_length(coalesce(url, '')) + octet_length(coalesce(notes, '')) from bookmarks where user_email = ${tenant} and deleted_at is null
      union all select octet_length(coalesce(title, '')) from reminders where user_email = ${tenant} and deleted_at is null
      union all select octet_length(coalesce(section_title, '')) + octet_length(coalesce(content, '')) + octet_length(coalesce(subsection_of::text, '')) from talking_points where user_email = ${tenant} and deleted_at is null
      union all select octet_length(coalesce(name, '')) from files where user_email = ${tenant} and deleted_at is null
    ) cards
  `;
  return { cards: Number(rows[0]?.count || 0), textBytes: Number(rows[0]?.text_bytes || 0) };
}

async function assertCardCreateAllowed(sql, tenant, type, values) {
  assertInputLimits(type, values);
  const usage = await getCardUsage(sql, tenant);
  if (usage.cards >= limits.maxCardsPerUser) {
    throw limitError(409, 'CARD_LIMIT_REACHED', `You have reached the ${limits.maxCardsPerUser}-card limit. Delete a card before adding another.`, usage.cards, limits.maxCardsPerUser, { resource: 'cards' });
  }
  const nextTextBytes = usage.textBytes + textBytesForCard(type, values);
  if (nextTextBytes > limits.maxTextBytesPerUser) {
    throw limitError(409, 'TEXT_STORAGE_LIMIT_REACHED', 'Adding this card would exceed your text storage limit. Shorten the card or remove older content.', usage.textBytes, limits.maxTextBytesPerUser, { attempted: nextTextBytes, resource: 'text_storage' });
  }
}

async function assertCardUpdateAllowed(sql, tenant, type, id, patch) {
  assertInputLimits(type, patch);
  const current = await getCardRow(sql, tenant, type, id);
  if (!current) return null;
  const next = { ...current, ...patch };
  const delta = textBytesForCard(type, next) - textBytesForCard(type, current);
  if (delta > 0) {
    const usage = await getCardUsage(sql, tenant);
    if (usage.textBytes + delta > limits.maxTextBytesPerUser) {
      throw limitError(409, 'TEXT_STORAGE_LIMIT_REACHED', 'This change would exceed your text storage limit. Shorten the card or remove older content.', usage.textBytes, limits.maxTextBytesPerUser, { attempted: usage.textBytes + delta, resource: 'text_storage' });
    }
  }
  return current;
}

// Storage counts only what is still kept, but the daily cap counts every
// upload, deleted or not: otherwise uploading and deleting in a loop would
// never reach it.
async function getUploadUsage(sql, tenant) {
  const rows = await sql`
    select coalesce(sum(byte_size) filter (where deleted_at is null), 0)::bigint as storage_bytes,
      count(*) filter (where created_at >= now() - interval '24 hours')::int as uploads_last_day
    from (
      select byte_size, created_at, deleted_at from files where user_email = ${tenant}
      union all select byte_size, created_at, deleted_at from attachments where user_email = ${tenant}
    ) uploads
  `;
  return { storageBytes: Number(rows[0]?.storage_bytes || 0), uploadsLastDay: Number(rows[0]?.uploads_last_day || 0) };
}

async function getGlobalBlobUsage(sql) {
  const rows = await sql`
    select coalesce(sum(byte_size), 0)::bigint as storage_bytes from (
      select byte_size from files where deleted_at is null
      union all select byte_size from attachments where deleted_at is null
    ) uploads
  `;
  return Number(rows[0]?.storage_bytes || 0);
}

async function assertUploadAllowed(sql, tenant, { size, parentType, parentId }) {
  if (size > limits.maxFileBytes) {
    throw limitError(413, 'FILE_TOO_LARGE', `Each file must be ${Math.floor(limits.maxFileBytes / MiB)} MB or smaller.`, size, limits.maxFileBytes, { resource: 'file_size' });
  }
  const [usage, globalBytes] = await Promise.all([getUploadUsage(sql, tenant), getGlobalBlobUsage(sql)]);
  if (usage.storageBytes + size > limits.maxFileBytesPerUser) {
    throw limitError(409, 'FILE_STORAGE_LIMIT_REACHED', 'This upload would exceed your file storage limit. Delete older files and try again.', usage.storageBytes, limits.maxFileBytesPerUser, { attempted: usage.storageBytes + size, resource: 'file_storage' });
  }
  if (usage.uploadsLastDay >= limits.maxUploadsPerDay) {
    throw limitError(429, 'UPLOAD_RATE_LIMIT_REACHED', `You can upload up to ${limits.maxUploadsPerDay} files per 24 hours. Try again later.`, usage.uploadsLastDay, limits.maxUploadsPerDay, { retry_after_seconds: 3600, resource: 'uploads' });
  }
  if (parentType && parentId) {
    const rows = await sql`select count(*)::int as count from attachments where user_email = ${tenant} and parent_type = ${parentType} and parent_id = ${parentId} and deleted_at is null`;
    const count = Number(rows[0]?.count || 0);
    if (count >= limits.maxAttachmentsPerCard) {
      throw limitError(409, 'ATTACHMENT_LIMIT_REACHED', `Each card can have up to ${limits.maxAttachmentsPerCard} attachments.`, count, limits.maxAttachmentsPerCard, { resource: 'attachments' });
    }
  }
  if (globalBytes + size > limits.blobStorageHardLimitBytes) {
    throw limitError(503, 'GLOBAL_FILE_STORAGE_LIMIT_REACHED', 'File uploads are temporarily unavailable while storage capacity is expanded. Please try again later.', globalBytes, limits.blobStorageHardLimitBytes, { resource: 'global_file_storage' });
  }
  return { globalStorageAlert: globalBytes + size >= limits.blobStorageAlertBytes };
}

function quotaSummaryFromSources(sources) {
  const cardTypes = [['learning', sources.learnings], ['kanban', sources.kanban], ['work', sources.work], ['family', sources.family], ['bookmark', sources.bookmarks], ['talking_point', sources.talking], ['reminder', sources.reminders], ['file', sources.files]];
  const cards = cardTypes.reduce((total, [, rows]) => total + rows.length, 0);
  const textBytes = cardTypes.reduce((total, [type, rows]) => total + rows.reduce((sum, row) => sum + textBytesForCard(type, row), 0), 0);
  const fileBytes = [...sources.files, ...sources.attachments].reduce((total, row) => total + Number(row.byte_size || 0), 0);
  const usage = (used, limit) => ({ used, limit, remaining: Math.max(0, limit - used), warning: used >= limit * 0.8 });
  return {
    cards: usage(cards, limits.maxCardsPerUser),
    text_storage: usage(textBytes, limits.maxTextBytesPerUser),
    file_storage: usage(fileBytes, limits.maxFileBytesPerUser),
    uploads_per_day: { limit: limits.maxUploadsPerDay },
    attachments_per_card: { limit: limits.maxAttachmentsPerCard },
    file_size: { limit: limits.maxFileBytes },
    title: { limit: limits.maxTitleChars },
    content: { limit: limits.maxContentChars },
  };
}

module.exports = {
  limits, LimitError, byteLength, textBytesForCard, assertInputLimits,
  getCardRow, getCardUsage, assertCardCreateAllowed, assertCardUpdateAllowed,
  assertUploadAllowed, quotaSummaryFromSources,
};
