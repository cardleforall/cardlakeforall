const fs = require('fs');
const path = require('path');

// The MCP Apps view (extension io.modelcontextprotocol/ui, spec 2026-01-26):
// hosts that support it render list_feed, search_cards and get_card results
// as Cardlake cards instead of text. Hosts that don't simply ignore the tool
// _meta below and show the text as before.
//
// The official @modelcontextprotocol/ext-apps helpers need MCP SDK v2 (Cardlake
// is on 1.x), so this follows the spec directly: one ui:// resource holding a
// self-contained HTML document, and _meta.ui.resourceUri on the tools.
const CARDS_VIEW_URI = 'ui://cardle/cards.html';
const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

// ChatGPT's Apps SDK keys off its own resource MIME type rather than the MCP
// Apps one above (see openai/openai-apps-sdk-examples), so it gets a second
// resource -- same HTML, its own URI and MIME type -- alongside the first.
// The original resource and everything pointing at it (Claude) is untouched.
const CARDS_VIEW_URI_OPENAI = 'ui://cardle/cards-openai.html';
const OPENAI_WIDGET_MIME_TYPE = 'text/html+skybridge';

// Read once per cold start. The view is static -- the same for every
// account -- and gets its cards from the host, never from the server.
// The view links back to this deployment, whatever its address.
const CARDS_VIEW_HTML = fs.readFileSync(path.join(__dirname, 'mcp-app', 'cards.html'), 'utf8')
  .replace('__CARDLE_ORIGIN__', require('./public-origin').publicOrigin());

// For the tools whose results the view can show. ui.resourceUri is the MCP
// Apps standard key Claude reads; the flat "ui/resourceUri" is its
// deprecated spelling, kept for hosts that only read it. openai/outputTemplate
// points ChatGPT at its own skybridge-typed resource, and openai/widgetAccessible
// is required for ChatGPT to treat the tool as eligible to render one at all.
const CARDS_VIEW_META = {
  ui: { resourceUri: CARDS_VIEW_URI },
  'ui/resourceUri': CARDS_VIEW_URI,
  'openai/outputTemplate': CARDS_VIEW_URI_OPENAI,
  'openai/widgetAccessible': true,
};

// The view needs no network and nothing from outside, so its content
// security policy allows no domains at all. It's declared explicitly, on the
// resource contents where hosts read it: ChatGPT runs a widget that doesn't
// declare one with its CSP off ("CSP off" in the chat), and its plugin review
// requires one. ui.csp is the MCP Apps standard form (camelCase), which
// OpenAI's reference now prefers; openai/widgetCSP is ChatGPT's older form,
// kept for hosts that only read that.
const WIDGET_CSP = { connectDomains: [], resourceDomains: [] };
const OPENAI_WIDGET_CSP = { connect_domains: [], resource_domains: [] };
const VIEW_CONTENT_META = { ui: { csp: WIDGET_CSP } };
const OPENAI_RESOURCE_META = {
  ...VIEW_CONTENT_META,
  'openai/widgetCSP': OPENAI_WIDGET_CSP,
  'openai/widgetDescription': 'Shows Cardlake cards from the feed or a search, with pin and like buttons.',
};

function registerCardsView(server) {
  server.registerResource('cardle_cards', CARDS_VIEW_URI, {
    title: 'Cardlake cards',
    description: 'Shows cards from list_feed, search_cards and get_card as Cardlake cards.',
    mimeType: MCP_APP_MIME_TYPE,
  }, async () => ({
    contents: [{ uri: CARDS_VIEW_URI, mimeType: MCP_APP_MIME_TYPE, text: CARDS_VIEW_HTML, _meta: VIEW_CONTENT_META }],
  }));
  server.registerResource('cardle_cards_openai', CARDS_VIEW_URI_OPENAI, {
    title: 'Cardlake cards',
    description: 'Shows cards from list_feed, search_cards and get_card as Cardlake cards (ChatGPT Apps SDK).',
    mimeType: OPENAI_WIDGET_MIME_TYPE,
    _meta: { 'openai/outputTemplate': CARDS_VIEW_URI_OPENAI, 'openai/widgetAccessible': true, ...OPENAI_RESOURCE_META },
  }, async () => ({
    contents: [{ uri: CARDS_VIEW_URI_OPENAI, mimeType: OPENAI_WIDGET_MIME_TYPE, text: CARDS_VIEW_HTML, _meta: OPENAI_RESOURCE_META }],
  }));
}

module.exports = { CARDS_VIEW_HTML, CARDS_VIEW_URI, CARDS_VIEW_URI_OPENAI, CARDS_VIEW_META, WIDGET_CSP, OPENAI_WIDGET_CSP, registerCardsView };
