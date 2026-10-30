// Local-dev entry point (dev_server.js routes by file path). Production reaches
// the same handler through api/vault.js; see api/_lib/integration-handlers.js.
module.exports = require('../../_lib/integration-handlers').integrationAction;
