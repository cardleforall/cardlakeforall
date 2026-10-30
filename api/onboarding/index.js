// Local dev entry point (dev_server.js routes by file path). Production reaches
// the same handler through api/vault.js (see .vercelignore and vercel.json).
const { withSessionGuard } = require('../_lib/session-guard');
const { onboardingHandler } = require('../_lib/onboarding');

module.exports = withSessionGuard(onboardingHandler);
