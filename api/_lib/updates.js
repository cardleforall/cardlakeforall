// Whether a newer Cardlake is out, so the app can show its owner "Update
// available" (public/vault/assets/vault.js), which leads to /updates.
//
// The server asks GitHub rather than the browser, so the page never talks to
// another site (vercel.json's Content-Security-Policy).
'use strict';

const UPSTREAM = 'cardleforall/cardlakeforall';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 3000;

let latest = null;

// The newest Cardlake commit: { sha, date }, or null when GitHub can't be
// reached. GitHub's commit feed, unlike its API, isn't limited per address,
// and a deployment shares its address with many others.
async function latestCardlake(now = Date.now()) {
  if (latest && now - latest.checked < CHECK_EVERY_MS) return latest.commit;
  let commit = null;
  try {
    const res = await fetch(`https://github.com/${UPSTREAM}/commits/main.atom`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) {
      const entry = (await res.text()).split('<entry>')[1] || '';
      const sha = /Grit::Commit\/([0-9a-f]{40})</.exec(entry)?.[1];
      const date = /<updated>([^<]+)<\/updated>/.exec(entry)?.[1];
      if (sha && date) commit = { sha, date };
    }
  } catch (_) { /* offline or slow: say nothing */ }
  latest = { commit, checked: now };
  return commit;
}

// Which Cardlake this copy runs. An update deploys a commit named "Update
// Cardlake to <commit>" (scripts/update_from_upstream.sh). Before the first
// one, the copy runs the Cardlake of the day it first started.
function runningCardlake(startedAt) {
  const commit = /^Update Cardlake to ([0-9a-f]{7,40})\b/.exec(process.env.VERCEL_GIT_COMMIT_MESSAGE || '')?.[1];
  if (commit) return { commit };
  return startedAt ? { startedAt } : null;
}

function isNewer(newest, running) {
  if (!newest || !running) return false;
  if (running.commit) return !newest.sha.startsWith(running.commit);
  return Date.parse(newest.date) > Date.parse(running.startedAt);
}

function forgetLatest() {
  latest = null;
}

module.exports = { UPSTREAM, forgetLatest, isNewer, latestCardlake, runningCardlake };
