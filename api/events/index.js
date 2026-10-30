// Local dev only (.vercelignore'd): production reaches the same handler
// through api/vault.js via vercel.json's /api/events rewrite.
module.exports = require('../_lib/events').clientEventsHandler;
