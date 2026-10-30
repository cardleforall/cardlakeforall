// Everything specific to connecting and running an integration (currently
// GitHub Issues): the one-time onboarding sheet, "sync now", the status line,
// and the Manage panel. The feed owns the entry points (the integration chips
// and the bar above a filtered integration) and what happens afterwards.
// Onboarding progress is saved on the server after every step, so closing the
// sheet midway resumes where the user left off, on any device.
(function () {
  'use strict';
  const V = window.Cardle;
  const esc = value => V.escapeHtml(value);

  const GITHUB_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/></svg>';

  // What the flow says, per integration. The steps themselves come from the
  // server's registry (onboarding_step values), so the two cannot disagree.
  const COPY = {
    github_issues: {
      icon: GITHUB_ICON,
      headline: 'Bring your GitHub issues into your feed',
      lede: 'Open issues from one repository show up alongside everything else you keep in Cardlake, so nothing important sits unseen in another tab.',
      points: ['Open issues land in your daily feed', 'One tap filters to just your issues', 'Read-only: keep working in GitHub, Cardlake follows along'],
      itemNoun: ['issue', 'issues'],
      syncPath: '/api/integrations/github/sync',
      connectionPath: '/api/integrations/github',
    },
  };
  const PROGRESS = [['intro', 'Intro'], ['connect', 'Connect'], ['done', 'Done']];
  // HTML `pattern` compiles with the regex `v` flag, where a literal hyphen in
  // a character class must be escaped -- unescaped, browsers ignore the whole
  // pattern. Mirrors GITHUB_OWNER_RE / GITHUB_REPO_RE in integration-handlers.js.
  const REPO_PATTERN = '[A-Za-z0-9][A-Za-z0-9\\-]*/[A-Za-z0-9._\\-]+';

  function saveStep(integration, step) {
    // Best effort: losing a resume point is harmless, blocking the flow on it is not.
    V.api(`/api/integrations/${encodeURIComponent(integration.id)}/onboarding`, { method: 'POST', body: JSON.stringify({ step }) }).catch(() => {});
  }

  // Where to (re)start: a first-timer sees the intro; someone who left midway
  // resumes at their saved step; someone reconnecting after a disconnect has
  // already seen the pitch and goes straight to connecting.
  function startStep(integration) {
    if (integration.status === 'onboarding') return integration.onboarding_step || 'intro';
    if (integration.status === 'disconnected') return 'connect';
    return 'intro';
  }

  function progressHtml(step) {
    // On the done screen every segment reads as complete, not "in progress".
    const current = step === 'done' ? PROGRESS.length : PROGRESS.findIndex(([key]) => key === step);
    return `<ol class="integ-progress" aria-label="Setup progress">${PROGRESS.map(([key, label], index) => `<li class="${index < current ? 'is-done' : index === current ? 'is-current' : ''}" ${index === current ? 'aria-current="step"' : ''}><span>${label}</span></li>`).join('')}</ol>`;
  }

  function introHtml(copy) {
    return `<div class="integ-hero" aria-hidden="true">${copy.icon}</div>
      <h2 id="integ-title" tabindex="-1">${esc(copy.headline)}</h2>
      <p class="integ-lede">${esc(copy.lede)}</p>
      <ul class="integ-points">${copy.points.map(point => `<li>${esc(point)}</li>`).join('')}</ul>
      <div class="integ-actions"><button type="button" class="aurora-new integ-primary" data-integ-next="connect">Get started</button></div>`;
  }

  function connectHtml() {
    return `<h2 id="integ-title" tabindex="-1">Connect a GitHub repository</h2>
      <p class="integ-lede">Use a fine-grained token scoped to just this repository, with <strong>Issues: Read-only</strong> and <strong>Metadata: Read-only</strong>. It is encrypted before it is stored.</p>
      <a class="integ-link" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">Create a token on GitHub ↗</a>
      <p class="integ-fineprint">Cardlake keeps a copy of this repository's issues (titles, descriptions, labels) so they can appear in your feed. <a href="/privacy.html#github" target="_blank" rel="noopener">What Cardlake stores ↗</a></p>
      <form class="integ-form" data-integ-connect novalidate>
        <label class="aurora-capture-label">Repository<input name="repo" required autocomplete="off" spellcheck="false" placeholder="owner/repo" pattern="${REPO_PATTERN}"></label>
        <label class="aurora-capture-label">Personal access token<input name="token" type="password" required autocomplete="off" spellcheck="false" placeholder="github_pat_…"></label>
        <p class="integ-error" data-integ-error role="alert"></p>
        <div class="integ-actions"><button type="button" class="aurora-quiet" data-integ-next="intro">← Back</button><button type="submit" class="aurora-new integ-primary" data-integ-submit>Connect &amp; sync</button></div>
      </form>`;
  }

  // result: { openCount, breakdown, syncError }
  function doneHtml(integration, copy, result) {
    const [one, many] = copy.itemNoun;
    const summary = result.openCount
      ? `${result.openCount} open ${result.openCount === 1 ? one : many} added to your feed.`
      : `No open ${many} right now. New ones will show up in your feed after the next sync.`;
    const breakdown = result.breakdown ? `<p class="integ-breakdown">${esc(result.breakdown)}</p>` : '';
    const warning = result.syncError ? `<p class="integ-warning" role="status">Connected, but the first sync didn't finish: ${esc(result.syncError)}</p>` : '';
    return `<div class="integ-done">
        <div class="integ-check" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
        <h2 id="integ-title" tabindex="-1">${esc(integration.name)} is live</h2>
        <p class="integ-lede">${esc(summary)}</p>${breakdown}${warning}
        <div class="integ-actions integ-actions-stacked"><button type="button" class="aurora-new integ-primary" data-integ-finish="filter">See your ${esc(many)}</button><button type="button" class="aurora-quiet" data-integ-finish="feed">Back to feed</button></div>
      </div>`;
  }

  // Open issues (backlog + in progress) are what the feed shows; closed ones
  // are archived out of it, so say so rather than overpromise.
  async function summarize(view) {
    let items = null;
    try { items = ((await V.api('/api/kanban')).items || []).filter(item => item.external_source === 'github'); } catch (_) { /* fall back to the view's count */ }
    if (!items) return { openCount: view.card_count, breakdown: '' };
    const count = status => items.filter(item => item.status === status).length;
    const [backlog, inProgress, done] = [count('backlog'), count('in_progress'), count('done')];
    const parts = [backlog && `${backlog} unassigned`, inProgress && `${inProgress} assigned`, done && `${done} closed (kept out of the feed)`].filter(Boolean);
    return { openCount: backlog + inProgress, breakdown: parts.join(', ') };
  }

  function relativeTime(iso) {
    const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
    if (!Number.isFinite(seconds)) return '';
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
      if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
    }
    return 'just now';
  }

  // One plain-text line describing a connected integration's sync health.
  function statusLine(integration) {
    if (integration.status === 'error') return `Last sync failed${integration.last_sync_error ? `: ${integration.last_sync_error}` : ''}`;
    return integration.last_synced_at ? `Synced ${relativeTime(integration.last_synced_at)}` : 'Not synced yet';
  }

  // Resolves to the server's { synced, last_synced_at }; rejects with the
  // API error (err.status 401 means the caller should prompt sign-in).
  function sync(integration) {
    const copy = COPY[integration.id];
    return V.api(copy.syncPath, { method: 'POST' });
  }

  // A small dialog shell shared by the onboarding sheet and the Manage panel:
  // labelled, Escape and backdrop close it, focus returns to the opener.
  function dialog(className, onDismiss) {
    const opener = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'aurora-overlay integ-overlay';
    overlay.innerHTML = `<div class="aurora-modal ${className}" role="dialog" aria-modal="true" aria-labelledby="integ-title"><button type="button" class="aurora-close" aria-label="Close">×</button><div data-integ-progress></div><div class="integ-body" data-integ-body></div></div>`;
    document.body.appendChild(overlay);
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
    function onKey(event) { if (event.key === 'Escape') onDismiss(close); }
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.aurora-close').onclick = () => onDismiss(close);
    overlay.onclick = event => { if (event.target === overlay) onDismiss(close); };
    return { overlay, sheet: overlay.querySelector('.aurora-modal'), body: overlay.querySelector('[data-integ-body]'), close };
  }

  // The panel for a connected integration: what it is connected to, how the
  // last sync went, and the two ways to change that. onChanged(what) is
  // called after 'disconnected' or 'reconnected'.
  function manage(integration, { onChanged } = {}) {
    const copy = COPY[integration.id];
    if (!copy) return;
    const { body, close } = dialog('integ-sheet integ-manage', done => done());
    const repoUrl = integration.repo ? `https://github.com/${integration.repo.split('/').map(encodeURIComponent).join('/')}` : null;
    const since = integration.connected_at ? new Date(integration.connected_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null;
    const rows = [
      ['Repository', repoUrl ? `<a class="integ-link" href="${esc(repoUrl)}" target="_blank" rel="noopener noreferrer">${esc(integration.repo)} ↗</a>` : '-'],
      ['Status', `<span class="${integration.status === 'error' ? 'integ-status-error' : ''}">${esc(statusLine(integration))}</span>`],
      since ? ['Connected', esc(since)] : null,
      // Includes closed issues, which the feed archives -- so not "in your feed".
      [`${copy.itemNoun[1][0].toUpperCase()}${copy.itemNoun[1].slice(1)} synced`, String(integration.card_count)],
    ].filter(Boolean);
    body.innerHTML = `<div class="integ-manage-head"><span class="integ-hero integ-hero-small" aria-hidden="true">${copy.icon}</span><h2 id="integ-title" tabindex="-1">${esc(integration.name)}</h2></div>
      <dl class="integ-details">${rows.map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`).join('')}</dl>
      <div class="integ-manage-action"><div><b>Change repository</b><span>Issues from the current repository leave your feed and the new one's arrive.</span></div><button type="button" class="aurora-quiet integ-secondary" data-integ-change>Change</button></div>
      <div class="integ-manage-action"><div><b>Disconnect</b><span>Your ${esc(copy.itemNoun[1])} leave the feed. Nothing is deleted, and you can reconnect any time.</span></div><button type="button" class="aurora-quiet integ-danger" data-integ-disconnect>Disconnect</button></div>
      <p class="integ-error" data-integ-error role="alert"></p>`;
    body.querySelector('#integ-title').focus({ preventScroll: true });
    body.querySelector('[data-integ-change]').onclick = () => {
      close();
      open(integration, { startAt: 'connect', onFinished: () => onChanged?.('reconnected') });
    };
    // Inline confirm rather than the browser's native confirm dialog, which
    // embedded/webview browsers silently suppress (the same fix vault.js uses
    // for token revoke).
    const disconnect = body.querySelector('[data-integ-disconnect]');
    disconnect.onclick = () => {
      if (disconnect.dataset.confirming) return;
      disconnect.dataset.confirming = 'true';
      const confirmBox = document.createElement('div');
      confirmBox.className = 'integ-confirm';
      confirmBox.innerHTML = `<span>Disconnect ${esc(integration.name)}?</span><button type="button" class="aurora-quiet" data-integ-cancel>Cancel</button><button type="button" class="aurora-new integ-danger-solid" data-integ-confirm>Disconnect</button>`;
      disconnect.closest('.integ-manage-action').after(confirmBox);
      confirmBox.querySelector('[data-integ-cancel]').onclick = () => { confirmBox.remove(); delete disconnect.dataset.confirming; };
      const confirm = confirmBox.querySelector('[data-integ-confirm]');
      confirm.focus();
      confirm.onclick = async () => {
        confirm.disabled = true;
        try {
          await V.api(copy.connectionPath, { method: 'DELETE' });
          close();
          onChanged?.('disconnected');
        } catch (error) {
          confirm.disabled = false;
          body.querySelector('[data-integ-error]').textContent = error.message || 'Could not disconnect. Please try again.';
        }
      };
    };
  }

  // integration: the public view from /api/feed's `integrations` list.
  // onFinished(next, view): next is 'filter' | 'feed'. startAt skips to a
  // step (Manage's "Change repository" goes straight to 'connect').
  function open(integration, { onFinished, startAt } = {}) {
    const copy = COPY[integration.id];
    if (!copy) return;
    let finished = null;
    // Dismissing the done screen still counts as finishing (the feed reloads);
    // dismissing earlier just closes, and the saved step resumes next time.
    const { overlay, sheet, body, close } = dialog('integ-sheet', closeDialog => (finished ? finish('feed') : closeDialog()));
    function finish(next) {
      close();
      onFinished?.(next, finished);
    }

    const setError = message => { const node = body.querySelector('[data-integ-error]'); if (node) node.textContent = message || ''; };

    function show(step, result) {
      overlay.querySelector('[data-integ-progress]').innerHTML = progressHtml(step);
      sheet.dataset.step = step;
      if (step === 'intro') body.innerHTML = introHtml(copy);
      else if (step === 'connect') body.innerHTML = connectHtml();
      else body.innerHTML = doneHtml(integration, copy, result);
      if (step !== 'done') saveStep(integration, step);
      bind(step);
      body.querySelector('#integ-title')?.focus({ preventScroll: true });
      sheet.scrollTop = 0;
    }

    function bind(step) {
      body.querySelectorAll('[data-integ-next]').forEach(button => { button.onclick = () => show(button.dataset.integNext); });
      body.querySelectorAll('[data-integ-finish]').forEach(button => { button.onclick = () => finish(button.dataset.integFinish); });
      if (step !== 'connect') return;
      const form = body.querySelector('[data-integ-connect]');
      const submit = form.querySelector('[data-integ-submit]');
      form.onsubmit = async event => {
        event.preventDefault();
        setError('');
        const repo = form.repo.value.trim(), token = form.token.value.trim();
        if (!repo || !token) { setError('Enter both a repository and a token.'); return; }
        if (!form.repo.checkValidity()) { setError('Use the owner/repo format, e.g. octocat/hello-world.'); form.repo.focus(); return; }
        submit.disabled = true;
        submit.textContent = 'Connecting…';
        let view;
        try {
          view = await V.api('/api/integrations/github', { method: 'POST', body: JSON.stringify({ repo, token }) });
        } catch (error) {
          submit.disabled = false;
          submit.textContent = 'Connect & sync';
          setError(error.message || 'Could not connect to GitHub.');
          return;
        }
        submit.textContent = 'Syncing issues…';
        let syncError = null;
        try { await V.api('/api/integrations/github/sync', { method: 'POST' }); } catch (error) { syncError = error.message || 'GitHub did not respond.'; }
        finished = view;
        show('done', { syncError, ...(await summarize(view)) });
      };
    }

    show(startAt || startStep(integration));
  }

  window.CardleIntegrations = { open, manage, sync, statusLine };
}());
