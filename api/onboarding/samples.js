// Local dev entry point for DELETE /api/onboarding/samples; production routes it
// through api/vault.js (see .vercelignore and vercel.json).
const { withSessionGuard } = require('../_lib/session-guard');
const { onboardingHandler } = require('../_lib/onboarding');

module.exports = withSessionGuard((req, res) => {
  req.query = { ...(req.query || {}), action: 'samples' };
  return onboardingHandler(req, res);
});
