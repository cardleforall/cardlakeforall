// The address this Cardlake is served at, for links and OAuth metadata that
// must be absolute. Set CARDLE_PUBLIC_ORIGIN for a custom domain; on Vercel
// the project's own production domain is used otherwise. There is
// deliberately no fallback to any hosted Cardlake: a self-hosted copy must
// never send people or AI assistants to someone else's deployment.
'use strict';

function publicOrigin(env = process.env) {
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '';
  return (env.CARDLE_PUBLIC_ORIGIN || vercel || 'http://localhost:3000').replace(/\/$/, '');
}

module.exports = { publicOrigin };
