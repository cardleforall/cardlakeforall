const { allowMethods } = require('../_lib/http');
const { clearSessionCookie } = require('../_lib/auth');

module.exports = async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  req.cardleEvent = { type: 'auth.sign_out' };
  clearSessionCookie(res);
  res.status(200).json({ authenticated: false });
};
