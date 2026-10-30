const { del } = require('@vercel/blob');

// Deletes both the attachment rows and their underlying Blob objects for a
// given parent card, so dismissing/deleting a card doesn't leave orphaned
// files behind in storage. Soft-deletes the rows (consistent with every
// other table) after the actual Blob objects are gone.
async function purgeAttachments(sql, tenant, parentType, parentId) {
  let rows;
  try {
    rows = await sql`select id, blob_url from attachments where user_email = ${tenant} and parent_type = ${parentType} and parent_id = ${parentId} and deleted_at is null`;
  } catch (e) {
    // Allow pre-migration deployments without the attachments table to keep deleting items.
    if (e.message?.includes('attachments') && e.message?.includes('does not exist')) return;
    throw e;
  }
  if (!rows.length) return;
  await del(rows.map(row => row.blob_url)).catch(() => {});
  await sql`update attachments set deleted_at = now() where user_email = ${tenant} and parent_type = ${parentType} and parent_id = ${parentId} and deleted_at is null`;
}

module.exports = { purgeAttachments };
