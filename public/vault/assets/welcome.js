// First-run onboarding (public/welcome.html): sign in (on /signin) -> pick a
// starter feed -> the feed. The server decides who belongs here (GET
// /api/onboarding); anyone already set up is sent straight to the vault.
// Connecting Claude or ChatGPT is offered in the feed itself (vault.js), once
// there are cards to ask about.
(function () {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const TYPE_LABELS = { learning: 'Learn', reminder: 'Remind', work: 'Work', family: 'Family', bookmark: 'Saved', talking_point: 'Misc' };
  const PROGRESS = ['signin', 'persona', 'feed'];
  // The 1-3 steps are for a new account. Before sign-in the page can't tell a
  // newcomer from someone whose session lapsed, so they appear only once the
  // server has sent this account to onboarding.
  const ONBOARDING_STEPS = ['persona'];
  const state = { personas: [], persona: null, cardCount: 0 };

  async function api(path, options = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const error = new Error(data.error || 'Request failed'); error.status = res.status; error.code = data.code; throw error; }
    return data;
  }

  function show(step) {
    document.querySelectorAll('[data-step]').forEach(section => { section.hidden = section.dataset.step !== step; });
    $('[data-progress-steps]').hidden = !ONBOARDING_STEPS.includes(step);
    const current = step;
    PROGRESS.forEach((name, index) => {
      const item = document.querySelector(`[data-progress="${name}"]`);
      if (!item) return;
      if (name === current) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
      item.classList.toggle('done', index < PROGRESS.indexOf(current));
    });
    // Move focus to the new heading so keyboard and screen-reader users land on the new step.
    document.querySelector(`[data-step="${step}"] h1`)?.focus();
  }

  function goToFeed(justOnboarded, firstCard = false) {
    location.replace(`/vault/index.html${justOnboarded ? '?welcome=1' : ''}${justOnboarded && firstCard ? '&capture=reminder' : ''}`);
  }

  // ---- step 1: sign in ------------------------------------------------------

  // The owner signs in on its own page, which comes back here; before
  // anyone owns this Cardlake, first-run setup does the same.
  async function showSignIn() {
    let config = {};
    try { config = await api('/api/auth/config'); } catch (_) { /* send them to sign in */ }
    location.replace(config.setupNeeded ? '/setup' : '/signin?next=%2Fwelcome.html');
  }

  async function afterSignIn() {
    let status;
    try { status = await api('/api/onboarding'); } catch (_) { return goToFeed(false); }
    state.personas = status.personas || [];
    state.persona = status.persona;
    state.cardCount = status.cardCount || 0;
    if (!status.available) return goToFeed(false);
    if (status.needsOnboarding) return showPersonas();
    return goToFeed(false);
  }

  // ---- step 2: persona --------------------------------------------------------

  function personaHtml(persona) {
    const preview = persona.preview.map(card => `<li><b>${escapeHtml(TYPE_LABELS[card.type] || card.type)}</b><span>${escapeHtml(card.title)}</span></li>`).join('');
    return `<button type="button" class="persona" data-persona="${escapeHtml(persona.id)}"><h2>${escapeHtml(persona.name)}</h2><p class="tagline">${escapeHtml(persona.tagline)}</p><ul>${preview}</ul><span class="count" data-count>${persona.cardCount} starter cards</span></button>`;
  }

  // Someone who signed up by connecting Claude or ChatGPT may arrive here with
  // cards already saved from there: a starter feed goes alongside them.
  function describeExistingCards() {
    if (!state.cardCount) return;
    const cards = state.cardCount === 1 ? '1 card' : `${state.cardCount} cards`;
    $('[data-persona-lead]').textContent = `You already have ${cards} in Cardlake. Add a ready-made starter feed alongside them, or go straight to your feed.`;
    $('[data-start-own-wrap]').hidden = true;
    $('[data-start-empty-lead]').textContent = 'Happy with what you have?';
    $('[data-start-empty]').textContent = 'Go to my feed';
  }

  function showPersonas() {
    describeExistingCards();
    $('[data-personas]').innerHTML = state.personas.map(personaHtml).join('');
    document.querySelectorAll('[data-persona]').forEach(button => button.addEventListener('click', () => choosePersona(button.dataset.persona, button)));
    show('persona');
  }

  async function choosePersona(personaId, button, firstCard = false) {
    const error = $('[data-persona-error]');
    const controls = [...document.querySelectorAll('[data-persona], [data-start-empty], [data-start-own]')];
    controls.forEach(control => { control.disabled = true; });
    const count = button?.querySelector('[data-count]');
    const label = count?.innerHTML;
    if (button) button.setAttribute('aria-busy', 'true');
    if (count) count.textContent = 'Setting up your feed…';
    error.textContent = '';
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      await api('/api/onboarding', { method: 'POST', body: JSON.stringify({ persona: personaId, timeZone }) });
      state.persona = personaId;
      return goToFeed(true, firstCard);
    } catch (err) {
      if (err.code === 'ONBOARDING_UNAVAILABLE') return goToFeed(false);
      error.textContent = `Could not set up your feed: ${err.message}`;
      controls.forEach(control => { control.disabled = false; });
      if (button) button.removeAttribute('aria-busy');
      if (count) count.innerHTML = label;
    }
  }

  function wireStartButtons() {
    $('[data-start-empty]').addEventListener('click', () => choosePersona('empty', null));
    $('[data-start-own]').addEventListener('click', event => choosePersona('empty', event.currentTarget, true));
  }

  async function start() {
    wireStartButtons();
    let session = {};
    try { session = await api('/api/auth/session'); } catch (_) { /* treated as signed out */ }
    if (session.authenticated && session.isDefault === false) return afterSignIn();
    return showSignIn();
  }

  start();
})();
