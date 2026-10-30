const GITHUB_API = 'https://api.github.com';

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'cardle-kanban-sync',
  };
}

// Carries an HTTP status so callers can tell "the user gave us a bad token or
// repo" (4xx, show the message) from "GitHub itself failed" (502).
class GithubError extends Error {
  constructor(status, message, code = status === 502 ? 'GITHUB_UNAVAILABLE' : 'GITHUB_ACCESS_DENIED') {
    super(message);
    this.name = 'GithubError';
    this.status = status;
    this.code = code;
  }
}

// Least privilege: only fine-grained personal access tokens, which can be
// limited to one repository and read-only permissions. Classic tokens
// (ghp_... or legacy 40-hex) and OAuth/app tokens (gho_, ghu_, ghs_, ghr_)
// can reach every repository the user can, often with write access -- storing
// one would make a leak of Cardlake's database a leak of the user's whole
// GitHub account. Checked before GitHub is contacted, so the connect endpoint
// can't be used to probe what someone else's token can reach.
const FINE_GRAINED_PREFIX = 'github_pat_';
const tokenTooBroad = () => new GithubError(400, 'Use a fine-grained personal access token (it starts with github_pat_). Classic tokens can reach every repository you have access to, so Cardlake does not accept them.', 'GITHUB_TOKEN_TOO_BROAD');

function assertFineGrainedToken(token) {
  if (!String(token).startsWith(FINE_GRAINED_PREFIX)) throw tokenTooBroad();
}

// Confirms the token can read this repo AND its issues before we ever save it.
async function validateGithubAccess(token, owner, repo) {
  assertFineGrainedToken(token);
  const repoRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, { headers: headers(token) });
  if (repoRes.status === 401) throw new GithubError(400, 'GitHub rejected the token. Check it is valid and has not expired.');
  if (repoRes.status === 404) throw new GithubError(400, 'Repository not found, or the token cannot access it.');
  if (!repoRes.ok) throw new GithubError(502, `GitHub API error (${repoRes.status})`);
  // Belt and braces: GitHub reports OAuth scopes only for classic/OAuth tokens,
  // so their presence means a broad token got past the prefix check.
  if (repoRes.headers?.get?.('x-oauth-scopes') != null) throw tokenTooBroad();
  const issuesRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues?per_page=1`, { headers: headers(token) });
  if (!issuesRes.ok) throw new GithubError(400, 'The token does not have permission to read issues on this repository.');
  return repoRes.json();
}

// Issues endpoint also returns pull requests; filter those out. Capped at a
// few hundred, sorted by most-recently-updated, which is plenty for a v1
// sync with no background worker to page through everything indefinitely.
async function fetchIssues(token, owner, repo, { maxPages = 3, perPage = 100 } = {}) {
  const issues = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/issues?state=all&per_page=${perPage}&page=${page}&sort=updated&direction=desc`;
    const res = await fetch(url, { headers: headers(token) });
    if (!res.ok) throw new GithubError(502, `GitHub API error while listing issues (${res.status})`);
    const batch = await res.json();
    for (const item of batch) {
      if (!item.pull_request) issues.push(item);
    }
    if (batch.length < perPage) break;
  }
  return issues;
}

module.exports = { GithubError, assertFineGrainedToken, validateGithubAccess, fetchIssues };
