// Local dev entry point (dev_server.js routes by file path). Production reaches
// the same handler through api/vault.js (see .vercelignore and vercel.json).
const { withSessionGuard } = require('../_lib/session-guard');
const { surpriseHandler } = require('../_lib/surprise');

module.exports = withSessionGuard(surpriseHandler);
