// Local-dev copy of api/auth.js's sign-out-everywhere route; both call
// _lib/account-routes.js.
const { signOutEverywhereHandler } = require('../_lib/account-routes');

module.exports = signOutEverywhereHandler;
