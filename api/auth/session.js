const { allowMethods } = require('../_lib/http');
const { getSessionPayload, isAuthenticatedRequest } = require('../_lib/auth');

module.exports = async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  const payload = getSessionPayload(req);
  if (payload?.email) {
    res.status(200).json({ authenticated: true, email: payload.email, name: payload.name || null, picture: payload.picture || null, isDefault: false });
    return;
  }
  res.status(200).json({ authenticated: isAuthenticatedRequest(req), email: null, name: null, picture: null, isDefault: true });
};
