const { registerTools } = require('./mcp-tools');
const { registerPrompts } = require('./mcp-prompts');
const { registerCardsView } = require('./mcp-app');

const SITE = require('./public-origin').publicOrigin();

// What a client shows for this server in its connector list. Icons are served
// from this deployment itself (public/), never a third-party host, which would see
// every client that renders them. One set works on light and dark themes: the
// mark sits on its own solid tile.
const SERVER_INFO = {
  name: 'cardle',
  title: 'Cardlake',
  version: '1.0.0',
  description: 'Your reminders, learnings, work, bookmarks and ideas, reviewed as one daily feed.',
  websiteUrl: SITE,
  icons: [
    { src: `${SITE}/favicon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
    { src: `${SITE}/icon-192.png`, mimeType: 'image/png', sizes: ['192x192'] },
    { src: `${SITE}/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] },
  ],
};

// Sent to the model once, when a client connects. The same for every account:
// nothing here may depend on the tenant.
const INSTRUCTIONS = [
  'Cardlake keeps one person\'s reminders, learnings (articles, videos, courses), work items with checklists, family updates, bookmarks, Misc cards (card type "talking_point") and synced GitHub issues as cards in a single daily feed.',
  'To find a card, use search_cards for text (it also finds snoozed and finished cards) or list_feed to browse the feed. Both return each card\'s type and id, which get_card and every update, delete and feed action (snooze, pin, like) need. Use filters rather than paging through everything.',
  'GitHub issues are card type "kanban" and are read-only here: they can be snoozed, pinned or liked, and refreshed with sync_github_issues, but are created and edited on GitHub.',
  'Cardlake sends no notifications: a reminder is not pushed or emailed, it rises to the top of the feed once its due date passes. Don\'t tell the user they will be notified.',
  'Dates such as due_date take "YYYY-MM-DD" or an ISO 8601 timestamp with the user\'s UTC offset (e.g. 2026-10-05T09:00:00+05:30); a time without an offset is refused. Resolve relative dates like "tomorrow" in the user\'s own time zone. Card subtitles show times in UTC.',
  'Deleting a card removes it from Cardlake together with its pins, likes and attachments, and it cannot be restored from the app, so confirm with the user first. At most 3 cards can be pinned at once.',
  'Results from list_feed, search_cards and get_card already render as interactive Cardlake cards in clients that support MCP Apps; other clients show the same data as plain text.',
].join('\n\n');

// Builds the MCP server for one request, scoped to one tenant. Kept apart from
// the HTTP handler (api/mcp.js) so what a client sees on connect -- server
// info, instructions, tools -- can be exercised without auth or a database.
async function createMcpServer(tenant, scopes) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  // OAuth clients receive only tools covered by their granted scope. Personal
  // access tokens retain the full Cardlake read/write toolset.
  registerTools(server, tenant, scopes);
  registerPrompts(server);
  registerCardsView(server);
  return server;
}

module.exports = { createMcpServer };
