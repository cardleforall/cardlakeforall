(function () {
  'use strict';
  const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // A saved link becomes an <a href> only if it is a web link; anything else
  // (an older javascript: or data: value) shows as text, so a click can't run it.
  const webLink = value => (/^https?:\/\//i.test(String(value ?? '').trim()) ? String(value).trim() : null);
  async function api(path, options = {}) {
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const headers = isFormData ? (options.headers || {}) : { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
    const data = await res.json().catch(() => ({ ok: false, error: 'Invalid server response' }));
    if (!res.ok) { const err = new Error(data.error || 'Request failed'); err.status = res.status; err.code = data.code; err.details = data.details; throw err; }
    return data;
  }
  async function checkAuth() {
      if (window._cardleAuthenticated) return true;
       if (localStorage.getItem('cardle_authenticated') === 'true') return true;
       try {
         const authenticated = (await api('/api/auth/session')).authenticated === true;
         if (authenticated) window.Cardle.auth = true;
         return authenticated;
       } catch (_) { return false; }
   }
  function showMessage(root, message) { root.innerHTML = `<div class="card"><div class="card-body">${escapeHtml(message)}</div></div>`; }
  // The sign-in page, coming back here afterwards.
  function signInUrl() {
    return `/signin?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
  }
  // A user hitting a 401 mid-action (signed out, or signed out in another
  // tab) signs in again on /signin, which brings them back here.
  function showLogin() {
    location.href = signInUrl();
  }
  function editor(title, fields, item, onSave) {
    const modal = document.createElement('div');
    modal.className = 'vh-modal';
    modal.innerHTML = `<div class="vh-modal-card"><form><h3>${escapeHtml(title)}</h3>${fields.map(field => {
      const value = item?.[field.name] ?? field.default ?? '';
      if (field.type === 'textarea') return `<label>${escapeHtml(field.label)}<textarea name="${field.name}" ${field.required ? 'required' : ''}>${escapeHtml(Array.isArray(value) ? value.map(entry => (entry && typeof entry === 'object' ? entry.text ?? '' : entry)).join('\n') : value)}</textarea></label>`;
      if (field.type === 'select') return `<label>${escapeHtml(field.label)}<select name="${field.name}">${field.options.map(x => `<option value="${x}" ${x === value ? 'selected' : ''}>${escapeHtml(x.replace('_', ' '))}</option>`).join('')}</select></label>`;
      return `<label>${escapeHtml(field.label)}<input type="${field.type || 'text'}" name="${field.name}" value="${escapeHtml(value)}" ${field.required ? 'required' : ''}></label>`;
    }).join('')}<p class="vh-error"></p><div><button type="button" class="vh-cancel">Cancel</button><button type="submit">Save</button></div></form></div>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('.vh-cancel').onclick = close;
    modal.onclick = e => { if (e.target === modal) close(); };
    modal.querySelector('form').onsubmit = async e => {
      e.preventDefault(); const form = new FormData(e.target); const values = {};
      fields.forEach(field => { let value = form.get(field.name); if (field.type === 'checkbox') value = form.get(field.name) === 'on'; if (field.json) value = String(value || '').split('\n').map(x => x.trim()).filter(Boolean); values[field.name] = value === '' ? null : value; });
      try { await onSave(values); close(); } catch (error) { modal.querySelector('.vh-error').textContent = error.message; }
    };
  }
  async function remove(path) { return api(path, { method: 'DELETE' }); }
  function renderAccountChip(container, { email, name, picture }) {
    container.innerHTML = `<span class="cardle-account-chip"><span class="cardle-account-id">${picture ? `<img class="cardle-account-avatar" src="${escapeHtml(picture)}" alt="" referrerpolicy="no-referrer">` : ''}<span class="cardle-account-email">${escapeHtml(name || email)}</span></span><button type="button" class="cardle-api-tokens-btn" title="Connect Claude, ChatGPT or another AI assistant to Cardlake">Connect AI</button><button type="button" class="cardle-signout-btn" aria-label="Sign out" title="Sign out"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="M16 17l5-5-5-5"></path><path d="M21 12H9"></path></svg><span>Sign out</span></button></span>`;
    container.querySelector('.cardle-api-tokens-btn').addEventListener('click', event => openApiTokensModal(event.currentTarget));
    container.querySelector('.cardle-signout-btn').addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) { /* cookie may already be gone */ }
      window._cardleAuthenticated = false;
      window.Cardle.auth = false;
      localStorage.removeItem('cardle_authenticated');
      window.dispatchEvent(new Event('cardle:auth-changed'));
      window.location.href = '/signin';
    });
  }
  // When a newer Cardlake is out, the owner sees "Update available", which
  // leads to /updates (api/_lib/updates.js decides).
  async function showUpdateAvailable(container) {
    try {
      if (!(await api('/api/auth/update')).available) return;
      container.querySelector('.cardle-account-chip').insertAdjacentHTML('afterbegin', '<a class="cardle-update-btn" href="/updates" title="A newer version of Cardlake is out">Update available</a>');
    } catch (_) { /* no notice */ }
  }
  // Personal access tokens let a client that can't hold a browser session
  // cookie (the MCP server, a script) authenticate as this same user. Each
  // token's plaintext is shown exactly once, right after creation.
  // "20 Sept 2026", not "9/20/2026": a numeric date reads differently by
  // country, and the feed already spells its months.
  const tokenDate = value => new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  function apiTokenRowHtml(token) {
    const used = token.last_used_at ? `Last used ${tokenDate(token.last_used_at)}` : 'Never used';
    return `<li class="cardle-token-row" data-token-id="${escapeHtml(token.id)}"><div><strong>${escapeHtml(token.label || 'Untitled token')}</strong><small>Created ${tokenDate(token.created_at)}. ${escapeHtml(used)}</small></div><button type="button" class="cardle-token-revoke" data-revoke="${escapeHtml(token.id)}">Revoke</button></li>`;
  }
  async function refreshApiTokensList(modal) {
    const list = modal.querySelector('[data-token-list]');
    list.innerHTML = '<li class="cardle-token-empty">Loading…</li>';
    try {
      const { tokens } = await api('/api/auth/tokens');
      list.innerHTML = tokens.length ? tokens.map(apiTokenRowHtml).join('') : '<li class="cardle-token-empty">No tokens yet.</li>';
      // Inline confirm, not window.confirm(): embedded/webview browsers (including this
      // app's own preview pane) silently suppress native dialogs and return false, which
      // made Revoke look like it did nothing. Matches the delete-confirm pattern in bindControls.
      list.querySelectorAll('[data-revoke]').forEach(button => button.addEventListener('click', () => {
        if (button.dataset.confirming) return;
        button.dataset.confirming = 'true';
        const confirmBox = document.createElement('span');
        confirmBox.className = 'vh-delete-confirm';
        confirmBox.innerHTML = '<span>Revoke?</span><button type="button" class="vh-delete-yes">Revoke</button><button type="button" class="vh-delete-no">Cancel</button>';
        button.after(confirmBox); button.hidden = true;
        const cancel = () => { confirmBox.remove(); button.hidden = false; delete button.dataset.confirming; };
        confirmBox.querySelector('.vh-delete-no').onclick = cancel;
        confirmBox.querySelector('.vh-delete-yes').onclick = async () => {
          const yes = confirmBox.querySelector('.vh-delete-yes'); yes.disabled = true;
          try { await api(`/api/auth/tokens/${button.dataset.revoke}`, { method: 'DELETE' }); await refreshApiTokensList(modal); }
          catch (error) { yes.disabled = false; confirmBox.querySelector('span').textContent = `Could not revoke: ${error.message}`; }
        };
      }));
    } catch (error) {
      list.innerHTML = `<li class="cardle-token-empty">Could not load tokens: ${escapeHtml(error.message)}</li>`;
    }
  }
  // Copy buttons say whether it worked. Where the clipboard is blocked, the
  // text is selected instead so it can be copied by hand.
  function wireCopy(button, code) {
    button.onclick = async () => {
      try { await navigator.clipboard.writeText(code.textContent); button.textContent = 'Copied'; }
      catch (_) {
        const range = document.createRange(); range.selectNodeContents(code);
        getSelection().removeAllRanges(); getSelection().addRange(range);
        button.textContent = 'Selected: copy it';
      }
      setTimeout(() => { if (button.isConnected) button.textContent = 'Copy'; }, 2500);
    };
  }
  // "Waiting for your assistant to connect…", then example questions once it
  // has, for someone who hasn't connected one yet. Already-connected
  // accounts see no status: we
  // can't tell which assistant is connected, so "Connected" could mislead
  // someone adding a second one.
  async function watchForAssistantConnection(modal) {
    const status = modal.querySelector('[data-connect-status]');
    try { if ((await api('/api/onboarding')).aiConnected === true) return; } catch (_) { return; }
    status.hidden = false;
    status.textContent = 'Waiting for your assistant to connect…';
    whenAssistantConnects(modal, () => {
      status.classList.add('connected');
      status.textContent = 'Connected. Your assistant can see your feed.';
      modal.querySelector('[data-connect-prompts]').hidden = false;
    });
  }
  // Checks every few seconds, for up to ten minutes, until an assistant
  // finishes its sign-in (Claude and ChatGPT do it in their own tab). Stops
  // early once `element` has left the page.
  function whenAssistantConnects(element, onConnected) {
    const stopAt = Date.now() + 10 * 60 * 1000;
    const timer = setInterval(async () => {
      if (!element.isConnected || Date.now() > stopAt) return clearInterval(timer);
      if (document.hidden) return;
      try {
        if ((await api('/api/onboarding')).aiConnected !== true) return;
        clearInterval(timer);
        onConnected();
      } catch (_) { /* try again on the next tick */ }
    }, 3000);
  }
  // The sync token, under Advanced. Only a generated one is shown (one set
  // in Vercel is never echoed back), and only to the owner
  // (api/_lib/account-routes.js).
  async function showSyncToken(modal) {
    let data;
    try { data = await api('/api/auth/instance'); } catch (_) { return; }
    const value = data?.sync_token?.value;
    if (!value || !modal.isConnected) return;
    const panel = modal.querySelector('[data-sync-token]');
    panel.querySelector('[data-sync-token-value]').textContent = value;
    wireCopy(panel.querySelector('[data-copy-sync]'), panel.querySelector('[data-sync-token-value]'));
    panel.hidden = false;
  }
  // opener gets focus back when the dialog closes (Safari doesn't focus a
  // clicked button, so it's passed in rather than read from activeElement).
  // view is where it opens: 'pick' (the choice of assistant) or one
  // assistant's steps.
  function openApiTokensModal(opener, view = 'pick') {
    document.getElementById('cardle-tokens-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'cardle-tokens-modal';
    modal.className = 'vh-modal';
    // Pick Claude, ChatGPT or Gemini first, then copy this Cardlake's address
    // and follow that assistant's steps. Tokens sit behind a small link
    // because only Claude Code and scripts need one. Example questions wait
    // until the assistant connects.
    const { SERVER_ADDRESS, EXAMPLE_PROMPTS, stepsHtml, promptsHtml } = window.CardleConnectAI;
    const addressHtml = `<div class="cardle-token-address"><code data-server-address>${escapeHtml(SERVER_ADDRESS)}</code><button type="button" data-copy-server>Copy</button></div>`;
    const ARROW = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
    modal.innerHTML = `<div class="vh-modal-card cardle-tokens-card" role="dialog" aria-modal="true" aria-labelledby="cardle-tokens-title"><h3 id="cardle-tokens-title" tabindex="-1">Connect your AI</h3><div data-connect-view="pick"><p>Then ask it what's on your plate, or tell it to add, snooze or tick things off.</p><div class="cardle-connect-picks"><button type="button" class="cardle-connect-pick" data-pick="claude"><span><b>Claude</b><small>Paste one link</small></span>${ARROW}</button><button type="button" class="cardle-connect-pick" data-pick="chatgpt"><span><b>ChatGPT</b><small>Paste one link</small></span>${ARROW}</button><button type="button" class="cardle-connect-pick" data-pick="gemini"><span><b>Gemini</b><small>Paste one link</small></span>${ARROW}</button></div><button type="button" class="cardle-connect-other" data-pick="token">Claude Code or a script?</button></div><div data-connect-view="claude" hidden>${addressHtml}<div class="cardle-connect-steps">${stepsHtml('claude')}</div></div><div data-connect-view="chatgpt" hidden>${addressHtml}<div class="cardle-connect-steps">${stepsHtml('chatgpt')}</div></div><div data-connect-view="gemini" hidden>${addressHtml}<div class="cardle-connect-steps">${stepsHtml('gemini')}</div></div><div data-connect-view="token" hidden><p>Claude Code, the Gemini CLI and scripts connect with a personal access token and the address <code>${escapeHtml(SERVER_ADDRESS)}</code>. Each token is shown only once, so copy it somewhere safe right away. <a href="/mcp-setup.html" target="_blank" rel="noopener noreferrer">Setup guide</a></p><div class="cardle-token-new"><input type="text" aria-label="Token label" placeholder="Label, e.g. Claude Code" maxlength="100"><button type="submit" class="vh-add" data-generate>Generate token</button></div><p class="cardle-token-error" data-token-error role="alert"></p><div class="cardle-token-reveal" data-token-reveal hidden></div><ul class="cardle-token-list" data-token-list></ul><details class="cardle-sync-token" data-sync-token hidden><summary>Advanced: sync token</summary><p>For scripts and Cardlake's system tests, not for assistants. It works in a separate shared space, never in your own cards. Your Cardlake made it; keep it private.</p><code data-sync-token-value></code><button type="button" data-copy-sync>Copy</button></details></div><div data-connect-progress hidden><p class="cardle-connect-status" data-connect-status role="status" hidden></p><div data-connect-prompts hidden><h4>Now try asking</h4><div class="cardle-connect-prompts">${promptsHtml(EXAMPLE_PROMPTS.slice(0, 3))}</div></div></div><div class="cardle-connect-actions"><button type="button" class="vh-cancel" data-back hidden>Back</button><button type="button" class="vh-cancel" data-close>Close</button></div></div>`;
    document.body.appendChild(modal);
    const card = modal.querySelector('[role="dialog"]');
    const close = () => { modal.remove(); opener?.focus(); };
    const focusable = () => [...card.querySelectorAll('a[href], button:not([disabled]), input:not([disabled])')].filter(el => el.getClientRects().length);
    // Escape closes it and Tab cycles inside it, as in the feed's dialogs.
    card.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const targets = focusable(), first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    modal.onclick = e => { if (e.target === modal) close(); };
    modal.querySelector('[data-close]').onclick = close;
    modal.querySelectorAll('.cardle-token-address').forEach(row => wireCopy(row.querySelector('[data-copy-server]'), row.querySelector('[data-server-address]')));
    const back = modal.querySelector('[data-back]');
    // The waiting status and, once connected, the example questions belong
    // to the Claude, ChatGPT and Gemini steps only.
    const showView = (view, focus) => {
      modal.querySelectorAll('[data-connect-view]').forEach(el => { el.hidden = el.dataset.connectView !== view; });
      modal.querySelector('[data-connect-progress]').hidden = !['claude', 'chatgpt', 'gemini'].includes(view);
      back.hidden = view === 'pick';
      focus?.focus();
    };
    const firstControl = view => modal.querySelector(`[data-connect-view="${view}"]`).querySelector('button, input');
    modal.querySelectorAll('[data-pick]').forEach(pick => pick.addEventListener('click', () => showView(pick.dataset.pick, firstControl(pick.dataset.pick))));
    back.onclick = () => showView('pick', modal.querySelector('[data-pick="claude"]'));
    showView(view, view === 'pick' ? modal.querySelector('[data-pick="claude"]') : firstControl(view));
    watchForAssistantConnection(modal);
    showSyncToken(modal);
    modal.querySelector('[data-generate]').addEventListener('click', async () => {
      const input = modal.querySelector('.cardle-token-new input');
      const button = modal.querySelector('[data-generate]');
      const error = modal.querySelector('[data-token-error]');
      button.disabled = true; error.textContent = '';
      try {
        const { token } = await api('/api/auth/tokens', { method: 'POST', body: JSON.stringify({ label: input.value.trim() }) });
        const serverAddress = window.CardleConnectAI.SERVER_ADDRESS;
        const reveal = modal.querySelector('[data-token-reveal]');
        reveal.hidden = false;
        reveal.innerHTML = `<p>Copy this now. It won't be shown again:</p><code data-new-token>${escapeHtml(token.token)}</code><button type="button" data-copy-token>Copy</button><p>Server address:</p><code data-new-address>${escapeHtml(serverAddress)}</code><button type="button" data-copy-addr>Copy</button><p><a href="/mcp-setup.html" target="_blank" rel="noopener noreferrer">Connect it to Claude Code, Gemini, or another client</a></p>`;
        wireCopy(reveal.querySelector('[data-copy-token]'), reveal.querySelector('[data-new-token]'));
        wireCopy(reveal.querySelector('[data-copy-addr]'), reveal.querySelector('[data-new-address]'));
        input.value = '';
        await refreshApiTokensList(modal);
      } catch (err) {
        // Shown in the dialog: embedded browsers silently drop alert().
        error.textContent = `Could not generate a token: ${err.message}`;
      } finally {
        button.disabled = false;
      }
    });
    refreshApiTokensList(modal);
  }
  // A brand-new account goes through onboarding (welcome.html) before its
  // first feed, even with cards saved from an assistant; an account with
  // starter cards is offered a way to clear them. Onboarding is optional: if
  // its API is unavailable the vault loads as usual.
  const SAMPLE_BANNER_DISMISSED = 'cardle-sample-banner-dismissed';
  const CONNECT_CARD_DISMISSED = 'cardle-connect-card-dismissed';
  const isDismissed = key => { try { return localStorage.getItem(key) === 'true'; } catch (_) { return false; } };
  const rememberDismissed = key => { try { localStorage.setItem(key, 'true'); } catch (_) { /* storage blocked */ } };
  async function followOnboarding() {
    let status;
    try { status = await api('/api/onboarding'); } catch (_) { return; }
    if (status.needsOnboarding) { location.replace('/welcome.html'); return; }
    if (status.sampleCount > 0 && !isDismissed(SAMPLE_BANNER_DISMISSED)) showSampleBanner(status.sampleCount, new URLSearchParams(location.search).get('welcome') === '1');
    // Added last so it sits above the sample banner: it's the one thing to do.
    if (status.aiConnected === false && !isDismissed(CONNECT_CARD_DISMISSED)) showConnectCard(status.personas?.find(persona => persona.id === status.persona)?.prompts);
    if (takeConnectRequest() && status.aiConnected === false) openApiTokensModal(null);
  }
  // Onboarding's "Also connect Claude or ChatGPT afterwards" (welcome.js) asks
  // for the connect steps once: the request is removed from the address so a
  // refresh doesn't reopen them.
  function takeConnectRequest() {
    const url = new URL(location.href);
    if (url.searchParams.get('welcome') !== '1' || url.searchParams.get('connect') !== '1') return false;
    url.searchParams.delete('connect');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    return true;
  }
  function showSampleBanner(count, justOnboarded) {
    const main = document.querySelector('.main');
    if (!main || document.getElementById('cardle-sample-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'cardle-sample-banner';
    banner.className = 'cardle-sample-banner';
    banner.setAttribute('role', 'status');
    const lead = justOnboarded ? '<strong>Your starter feed is ready.</strong> ' : '';
    banner.innerHTML = `<span>${lead}${count} of these cards are samples. Like or pin the ones you want to keep; the rest clear themselves after two weeks, or you can clear them now. Want more? Tap Deal me 5 for fresh videos and ideas.</span><button type="button" data-clear-samples>Clear sample cards</button><button type="button" class="cardle-sample-dismiss" data-dismiss aria-label="Hide this message">&times;</button>`;
    main.prepend(banner);
    const hide = () => { rememberDismissed(SAMPLE_BANNER_DISMISSED); banner.remove(); };
    banner.querySelector('[data-dismiss]').onclick = hide;
    banner.querySelector('[data-clear-samples]').onclick = async event => {
      event.target.disabled = true;
      try {
        const { cleared } = await api('/api/onboarding/samples', { method: 'DELETE' });
        banner.querySelector('span').textContent = `Cleared ${cleared} sample card${cleared === 1 ? '' : 's'}.`;
        event.target.remove();
        window.setTimeout(() => location.replace('/vault/index.html'), 900);
      } catch (error) {
        event.target.disabled = false;
        banner.querySelector('span').textContent = `Could not clear sample cards: ${error.message}`;
      }
    };
  }
  // Connecting Claude or ChatGPT is offered here, not during setup
  // (welcome.html): the feed already has cards, so the first question to the
  // assistant gets a real answer, and nobody has to leave setup half-done.
  // One main button at a time: "Add to Claude" until the connection is
  // confirmed, then example questions to try. "Not now" hides it for good;
  // Connect AI in the header stays. This Cardlake is added to Claude by its
  // own address, so the button opens Connect AI's Claude steps; the other
  // link opens its choice of assistant.
  function showConnectCard(personaPrompts) {
    const main = document.querySelector('.main');
    const { EXAMPLE_PROMPTS } = window.CardleConnectAI || {};
    if (!main || !EXAMPLE_PROMPTS || document.getElementById('cardle-connect-card')) return;
    const prompts = (personaPrompts?.length ? personaPrompts : EXAMPLE_PROMPTS).slice(0, 2);
    const card = document.createElement('section');
    card.id = 'cardle-connect-card';
    card.className = 'cardle-connect-card';
    card.setAttribute('aria-labelledby', 'cardle-connect-card-title');
    card.innerHTML = `<h2 id="cardle-connect-card-title">Ask Claude about your feed</h2><p data-connect-card-lead>Add Cardlake to Claude, then save and find cards right from your chat.</p><div class="cardle-connect-card-actions" data-connect-card-actions><button type="button" class="cardle-connect-card-primary" data-add-to-claude>Add to Claude</button><button type="button" class="cardle-connect-card-other" data-connect-other>Use ChatGPT or another assistant</button></div><p class="cardle-connect-status" data-connect-card-status role="status" hidden></p><div class="cardle-connect-card-prompts" data-connect-card-prompts hidden><p>Try asking</p>${prompts.map(prompt => `<button type="button" data-copy-prompt="${escapeHtml(prompt)}">&ldquo;${escapeHtml(prompt)}&rdquo;</button>`).join('')}</div><button type="button" class="cardle-connect-card-dismiss" data-dismiss aria-label="Not now" title="Not now">&times;</button>`;
    main.prepend(card);
    const status = card.querySelector('[data-connect-card-status]');
    const dismiss = card.querySelector('[data-dismiss]');
    let watching = false;
    const waitForConnection = () => {
      if (watching) return;
      watching = true;
      status.hidden = false;
      status.textContent = 'Waiting for you to connect…';
      whenAssistantConnects(card, () => {
        card.querySelector('#cardle-connect-card-title').textContent = 'You’re connected';
        card.querySelector('[data-connect-card-lead]').hidden = true;
        card.querySelector('[data-connect-card-actions]').hidden = true;
        status.classList.add('connected');
        status.textContent = 'Connected. Your assistant can see your feed.';
        card.querySelector('[data-connect-card-prompts]').hidden = false;
        dismiss.setAttribute('aria-label', 'Close');
        dismiss.title = 'Close';
      });
    };
    card.querySelector('[data-add-to-claude]').addEventListener('click', event => { waitForConnection(); openApiTokensModal(event.currentTarget, 'claude'); });
    card.querySelector('[data-connect-other]').addEventListener('click', event => { waitForConnection(); openApiTokensModal(event.currentTarget); });
    card.querySelectorAll('[data-copy-prompt]').forEach(button => button.addEventListener('click', async () => {
      const original = button.innerHTML;
      try { await navigator.clipboard.writeText(button.dataset.copyPrompt); button.textContent = 'Copied. Paste it into your assistant'; }
      catch (_) { button.textContent = 'Could not copy. Type it into your assistant'; }
      setTimeout(() => { if (button.isConnected) button.innerHTML = original; }, 2000);
    }));
    dismiss.addEventListener('click', () => { rememberDismissed(CONNECT_CARD_DISMISSED); card.remove(); });
  }
  // About & help's "Sign out on all devices" (api/_lib/account-routes.js).
  // A second click confirms, as Delete does in the feed: embedded browsers
  // silently suppress window.confirm().
  function bindSignOutEverywhere() {
    const panel = document.querySelector('[data-signout-all]');
    const button = panel?.querySelector('[data-signout-all-button]');
    if (!button) return;
    panel.hidden = false;
    button.addEventListener('click', async () => {
      if (!button.dataset.confirming) {
        button.dataset.confirming = 'true';
        button.textContent = 'Click again to sign out everywhere';
        return;
      }
      button.disabled = true;
      try {
        await api('/api/auth/sign-out-everywhere', { method: 'POST' });
        try { localStorage.removeItem('cardle_authenticated'); } catch (_) { /* storage blocked */ }
        location.href = '/signin';
      } catch (error) {
        button.disabled = false;
        button.textContent = `Could not sign out everywhere: ${error.message}`;
      }
    });
  }
  // This Cardlake is its owner's alone: a signed-out visitor signs in, or
  // sets it up while nobody owns it yet. There is no public feed to browse.
  async function initAuth() {
    const container = document.getElementById('cardle-auth');
    if (!container) return;
    try {
      const session = await api('/api/auth/session');
      if (session.authenticated && session.isDefault === false) {
        renderAccountChip(container, session);
        showUpdateAvailable(container);
        bindSignOutEverywhere();
        await followOnboarding();
        return;
      }
      const config = await api('/api/auth/config').catch(() => ({}));
      location.replace(config.setupNeeded ? '/setup' : signInUrl());
    } catch (_) { /* Leave the header unchanged if the session can't be read. */ }
  }
  // Controls remain visible to public visitors; their actions are authenticated on click and server-side.
  function controls(auth, item) { return `<span class="vh-actions"><button type="button" data-edit="${item.id}" data-auth="${auth}" aria-label="Edit item" title="Edit item"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button><button type="button" data-delete="${item.id}" data-auth="${auth}" aria-label="Delete item" title="Delete item"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg></button></span>`; }
  function showNotice(root, message) { const notice = root.querySelector('[data-vh-notice]'); if (!notice) return; notice.textContent = message; window.setTimeout(() => { if (notice.textContent === message) notice.textContent = ''; }, 3200); }
  function bindControls(root, items, auth, edit, destroy, unlock) {
    root.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => {
      const item = items.find(x => x.id === button.dataset.edit);
      if (!auth) return unlock(() => edit(item));
      edit(item);
    });
    root.querySelectorAll('[data-delete]').forEach(button => button.onclick = () => {
      if (!auth) return unlock();
      if (button.dataset.confirming) return;
      button.dataset.confirming = 'true';
      const confirmBox = document.createElement('span');
      confirmBox.className = 'vh-delete-confirm';
      confirmBox.innerHTML = '<span>Delete?</span><button type="button" class="vh-delete-yes">Delete</button><button type="button" class="vh-delete-no">Cancel</button>';
      button.after(confirmBox); button.hidden = true;
      const cancel = () => { confirmBox.remove(); button.hidden = false; delete button.dataset.confirming; };
      confirmBox.querySelector('.vh-delete-no').onclick = cancel;
      confirmBox.querySelector('.vh-delete-yes').onclick = async () => {
        const yes = confirmBox.querySelector('.vh-delete-yes'); yes.disabled = true;
        try { await destroy(button.dataset.delete); } catch (error) { yes.disabled = false; showNotice(root, `Could not delete: ${error.message}`); }
      };
    });
  }
  function wireTabs() {
    // A tab that no longer exists (e.g. the retired 'kanban' page) can still
    // arrive from an old #hash link; fall back to the feed rather than hiding
    // every page and rendering a blank screen.
    // The page lives in the address (#about), not localStorage: a remembered
    // tab made the app open on About & help, not the feed, every time after
    // one visit, and Back couldn't leave a page the address never showed.
    try { localStorage.removeItem('cardle-tab'); } catch (_) { /* storage blocked */ }
    window.showPage = function (name, fromAddress = false) {
      if (!document.getElementById(`page-${name}`)) name = 'overview';
      document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${name}`));
      document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.getAttribute('onclick')?.includes(`'${name}'`)));
      const hash = name === 'overview' ? '' : `#${name}`;
      if (!fromAddress && location.hash !== hash) history.pushState(null, '', `${location.pathname}${location.search}${hash}`);
      const app = window.CardleTabs?.[name]; if (app) app();
      return false;
    };
    window.addEventListener('popstate', () => window.showPage(location.hash.slice(1) || 'overview', true));
    window.toggleSec = el => { const body = el.parentElement.querySelector('.t-body'); body.style.display = body.style.display === 'none' ? 'block' : 'none'; el.querySelector('.t-arrow')?.classList.toggle('open'); };
    window.toggleSub = el => { const body = el.nextElementSibling; body.style.display = body.style.display === 'none' ? 'block' : 'none'; el.querySelector('.t-subarrow')?.classList.toggle('open'); };
    document.addEventListener('DOMContentLoaded', () => window.showPage(location.hash.slice(1) || 'overview', true));
  }
  function simpleResource(config) {
    let loaded = false;
    const root = () => document.getElementById(config.root);
    async function load() {
      const el = root(); if (!el || (loaded && !config.alwaysReload)) return; loaded = true; showMessage(el, 'Loading…');
      try { const [data, auth] = await Promise.all([api(config.path), checkAuth()]); render(data[config.itemsKey || 'items'] || [], auth); } catch (error) { showMessage(el, `Unable to load: ${error.message}`); }
    }
    function refresh() { loaded = false; return load(); }
    function render(items, auth) {
      const el = root();
      const unlock = action => showLogin(async () => { await refresh(); action?.(); });
      el.innerHTML = `<div class="vh-toolbar"><h2>${escapeHtml(config.title)}</h2><button class="vh-add">＋ Add</button><span class="vh-notice" data-vh-notice aria-live="polite"></span></div>${config.render(items, auth, controls) || '<div class="card"><div class="card-body">No items yet.</div></div>'}`;
      el.querySelector('.vh-add').addEventListener('click', () => auth ? edit() : unlock(() => edit()));
      bindControls(el, items, auth, edit, async id => { await remove(`${config.path}/${id}`); render(items.filter(item => item.id !== id), auth); showNotice(el, `${config.singular[0].toUpperCase()}${config.singular.slice(1)} deleted`); }, unlock);
    }
    function edit(item) { editor(item ? `Edit ${config.singular}` : `Add ${config.singular}`, config.fields, item, async values => { await api(item ? `${config.path}/${item.id}` : config.path, { method: item ? 'PATCH' : 'POST', body: JSON.stringify(values) }); await refresh(); }); }
    window.CardleTabs[config.tab] = load; return { load, refresh };
  }
  window.Cardle = { api, checkAuth, escapeHtml, webLink, showMessage, showLogin, editor, remove, controls, bindControls, simpleResource };
  window.CardleTabs = window.CardleTabs || {};
  wireTabs();
  initAuth();
})();
