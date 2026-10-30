(function () {
  'use strict';
  const V = window.Cardle;
  const SANDBOX = !!window.CARDLE_SANDBOX;
  // A recurring reminder's Delete reads "Done": it moves to the next
  // occurrence instead of being deleted (see dismissCard).
  const repeats = card => card.type === 'reminder' && !!card.metadata?.recurrence;
  // A GitHub issue is read-only here: removing its card leaves the issue
  // itself untouched, so its remove action says so instead of "Delete".
  const isGithubIssue = card => card.type === 'kanban' && card.metadata?.source === 'github';
  // A one-off reminder's Delete reads "Complete": finishing it is why it leaves the feed.
  const dismissLabel = card => repeats(card) ? 'Done' : isGithubIssue(card) ? 'Remove from Cardlake' : card.type === 'reminder' ? 'Complete' : 'Delete';
  const SANDBOX_SEED = [
    { id: 'sandbox-reminder', type: 'reminder', created_at: new Date(Date.now() - 2 * 3600e3).toISOString(), dismissed_at: null, remind_later_until: null, liked_at: null, pinned_at: null, title: 'Renew the domain registration', subtitle: 'Due tomorrow', body: "Auto-renew is off this cycle, so confirm before it lapses.", metadata: {} },
    { id: 'sandbox-learning', type: 'learning', created_at: new Date(Date.now() - 5 * 3600e3).toISOString(), dismissed_at: null, remind_later_until: null, liked_at: null, pinned_at: null, title: "Let's build GPT: from scratch, in code, spelled out.", subtitle: 'Video by Andrej Karpathy', body: 'A from-scratch walkthrough of how GPT actually works, one line of code at a time.', metadata: { url: 'https://www.youtube.com/watch?v=kCc8FmEb1nY' } },
    { id: 'sandbox-kanban', type: 'kanban', integration: 'github_issues', created_at: new Date(Date.now() - 8 * 3600e3).toISOString(), dismissed_at: null, remind_later_until: null, liked_at: null, pinned_at: null, title: 'Redesign the onboarding flow', subtitle: 'acme/app#42, Assigned', body: '', metadata: { status: 'in_progress', source: 'github', external_url: 'https://github.com/', labels: ['ux', 'onboarding'] } },
    { id: 'sandbox-work', type: 'work', created_at: new Date(Date.now() - 26 * 3600e3).toISOString(), dismissed_at: null, remind_later_until: null, liked_at: null, pinned_at: null, title: 'Q3 roadmap review', subtitle: '3/5 items done', body: "Finish the capacity section before Friday's sync.", metadata: {} },
    { id: 'sandbox-family', type: 'family', created_at: new Date(Date.now() - 30 * 3600e3).toISOString(), dismissed_at: null, remind_later_until: null, liked_at: null, pinned_at: null, title: 'Plan the weekend trip', subtitle: 'Family update', body: "Everyone's free Saturday. Pick a spot and book it.", metadata: {} },
    { id: 'sandbox-bookmark', type: 'bookmark', created_at: new Date(Date.now() - 50 * 3600e3).toISOString(), dismissed_at: null, remind_later_until: null, liked_at: null, pinned_at: null, title: 'Why complex systems fail', subtitle: '', body: 'A short paper on cascading failure in engineered systems.', metadata: {} },
    { id: 'sandbox-talking', type: 'talking_point', created_at: new Date(Date.now() - 70 * 3600e3).toISOString(), dismissed_at: null, remind_later_until: null, liked_at: null, pinned_at: null, title: 'Ask about the migration timeline', subtitle: '', body: 'Bring it up before the next planning sync.', metadata: {} },
  ];
  let sandboxCards = null;
  const sandboxAllCards = () => sandboxCards || (sandboxCards = SANDBOX_SEED.map(card => ({ ...card })));
  function sandboxApplyAction(card, action, days = 1) {
    const now = new Date().toISOString();
    if (action === 'dismiss') card.dismissed_at = now;
    else if (action === 'remind_later') card.remind_later_until = new Date(Date.now() + days * 86400e3).toISOString();
    else if (action === 'unremind_later') card.remind_later_until = null;
    else if (action === 'like') card.liked_at = now;
    else if (action === 'unlike') card.liked_at = null;
    else if (action === 'pin') card.pinned_at = now;
    else if (action === 'unpin') card.pinned_at = null;
  }
  function sandboxVisibleCards() {
    const all = sandboxAllCards();
    const base = state.view === 'snoozed' ? all.filter(c => c.remind_later_until) : all.filter(c => !c.dismissed_at && !c.remind_later_until);
    const shown = base.filter(c => (state.filter === 'all' || c.type === state.filter) && (!state.favoritesOnly || c.liked_at) && (!state.query || cardSearchText(c).includes(state.query.toLocaleLowerCase())));
    // The seed is already in a sensible "AI" order; date added is newest first.
    return state.view === 'active' && state.sort === 'newest' ? shown.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)) : shown;
  }
  function sandboxStats() {
    const all = sandboxAllCards();
    const active = all.filter(c => !c.dismissed_at && !c.remind_later_until);
    const countType = type => all.filter(c => c.type === type).length;
    return {
      learning_entries: countType('learning'), kanban_items: countType('kanban'), work_items: countType('work'),
      family_updates: countType('family'), bookmarks: countType('bookmark'), talking_points: countType('talking_point'),
      reminders: countType('reminder'), files: 0,
      liked_cards: active.filter(c => c.liked_at).length, pinned_cards: all.filter(c => c.pinned_at).length,
      max_pinned: 3, snoozed_count: all.filter(c => c.remind_later_until).length,
      review: { date: new Date().toISOString().slice(0, 10), reviewed_today: 0, total_today: active.length },
      streak_days: 3,
    };
  }
  // The demo shows GitHub Issues as an integration that is already set up, so the
  // separated Integrations chip group is part of what a visitor sees.
  function sandboxIntegrations() {
    return [{ id: 'github_issues', name: 'GitHub Issues', card_type: 'kanban', status: 'connected', repo: 'acme/app', last_synced_at: new Date(Date.now() - 4 * 60e3).toISOString(), acknowledged: true, card_count: sandboxAllCards().filter(c => c.type === 'kanban').length }];
  }
  function typeIcon(paths) { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`; }
  const ICONS = {
    reminder: typeIcon('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
    learning: typeIcon('<path d="M2 4h7a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-7a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h8z"/>'),
    // Kanban rows are GitHub issues in the feed (see api/_lib/integration-registry.js).
    kanban: typeIcon('<path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z" fill="currentColor" stroke="none"/>'),
    work: typeIcon('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/>'),
    family: typeIcon('<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    bookmark: typeIcon('<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>'),
    talking_point: typeIcon('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
    file: typeIcon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>')
  };
  const PIN_ICON = typeIcon('<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>');
  // Drawn, not "⌕" and "×": the search glyph fell back to a font that drew
  // it tiny and off-centre, so the button didn't read as search.
  const SEARCH_ICON = typeIcon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>');
  const CLOSE_ICON = typeIcon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');
  const TYPES = {
    reminder: [ICONS.reminder, 'Reminder', 'linear-gradient(135deg, oklch(60% .14 230), oklch(66% .12 212))', 'Complete'],
    learning: [ICONS.learning, 'Learning', 'linear-gradient(135deg, oklch(52% .17 262), oklch(58% .15 250))', 'Mark watched'],
    kanban: [ICONS.kanban, 'GitHub issue', 'linear-gradient(135deg, oklch(34% .03 265), oklch(46% .04 265))', 'Open'],
    work: [ICONS.work, 'Work', 'linear-gradient(135deg, oklch(48% .18 262), oklch(54% .16 255))', 'Snooze'],
    family: [ICONS.family, 'Family', 'linear-gradient(135deg, oklch(56% .15 245), oklch(62% .13 232))', 'Snooze'],
    bookmark: [ICONS.bookmark, 'Bookmark', 'linear-gradient(135deg, oklch(50% .16 258), oklch(56% .14 245))', 'Open'],
    talking_point: [ICONS.talking_point, 'Misc', 'linear-gradient(135deg, oklch(54% .16 250), oklch(60% .14 238))', 'Snooze'],
    file: [ICONS.file, 'File', 'linear-gradient(135deg, oklch(62% .12 215), oklch(68% .1 200))', 'Open']
  };
  const SWIPE_THRESHOLD = 90;
  const SWIPE_MAX_DRAG = 120;
  const esc = value => V.escapeHtml(String(value == null ? '' : value));
  // The feed's order (api/_lib/feed-ranking.js): "ai" ranks what matters now,
  // "newest" is date added. The choice is remembered per browser.
  const SORT_STORAGE_KEY = 'feed-sort';
  const SORTS = [['ai', 'AI', 'Due, in-progress and liked cards first, mixed by type'], ['newest', 'Date added', 'Newest cards first']];
  function savedSort() {
    try { return localStorage.getItem(SORT_STORAGE_KEY) === 'newest' ? 'newest' : 'ai'; } catch (_) { return 'ai'; }
  }
  function saveSort(sort) {
    try { localStorage.setItem(SORT_STORAGE_KEY, sort); } catch (_) {}
  }
  // Favorites is a session-only view, while the visual preference is shared with
  // the Learnings feed through its existing localStorage key.
  const state = { cards: [], stats: {}, integrations: [], filter: 'all', favoritesOnly: false, view: 'active', sort: savedSort(), query: '', cursor: null, loading: false, observer: null, openCard: null, surprise: null, justDealt: new Set() };
  const MEDIA_VISUALS_STORAGE_KEY = 'feed-media-visuals';
  const PINNED_COLLAPSED_KEY = 'feed-pinned-collapsed';
  const DEFAULT_MAX_PINNED = 3;
  const maxPinned = () => Number(state.stats.max_pinned || DEFAULT_MAX_PINNED);
  const pinnedCount = () => Number(state.stats.pinned_cards || 0);
  function pinnedCollapsed() {
    try { return localStorage.getItem(PINNED_COLLAPSED_KEY) === '1'; } catch (_) { return false; }
  }
  function setPinnedCollapsed(collapsed) {
    try { localStorage.setItem(PINNED_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (_) {}
  }
  const root = () => document.getElementById('dashboard-app');
  const cardKey = card => `${card.type}:${card.id}`;
  // The user-action log (api/_lib/events.js, docs/USER_EVENTS.md) records
  // everything that changes data on the server. This reports what only the
  // browser sees: cards shown and opened, links followed, searches, filters.
  // Batched, flushed every few seconds and when the page is hidden. The demo
  // feed records nothing.
  const feedContext = () => ({ view: state.view, sort: state.sort, filter: state.filter, favorites_only: state.favoritesOnly, query: state.query || null });
  const track = (() => {
    const queue = [];
    let timer = null;
    const send = body => {
      try { if (navigator.sendBeacon && navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }))) return; } catch (_) { /* fall back to fetch */ }
      fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'same-origin' }).catch(() => {});
    };
    const flush = () => {
      clearTimeout(timer); timer = null;
      while (queue.length) send(JSON.stringify({ events: queue.splice(0, 50) }));
    };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', flush);
    return (type, card, context) => {
      if (SANDBOX) return;
      queue.push({ type, item_type: card?.type || null, item_id: card?.id || null, context: context || {}, at: new Date().toISOString() });
      if (queue.length >= 20) flush(); else if (!timer) timer = setTimeout(flush, 5000);
    };
  })();
  const positionOf = card => state.cards.findIndex(c => cardKey(c) === cardKey(card));
  // A card counts as shown once it has been at least half on screen for a
  // second, once per card for each distinct feed query (view, filter, search).
  const impressions = { seen: new Set(), timers: new Map(), observer: null, contextKey: '' };
  function observeImpressions(r) {
    impressions.observer?.disconnect();
    impressions.timers.forEach(clearTimeout);
    impressions.timers.clear();
    if (SANDBOX || typeof IntersectionObserver !== 'function') return;
    impressions.observer = new IntersectionObserver(entries => entries.forEach(entry => {
      const key = `${entry.target.dataset.type}:${entry.target.dataset.id}`;
      if (!entry.isIntersecting) { clearTimeout(impressions.timers.get(key)); impressions.timers.delete(key); return; }
      if (impressions.seen.has(key) || impressions.timers.has(key)) return;
      impressions.timers.set(key, setTimeout(() => {
        impressions.timers.delete(key);
        impressions.seen.add(key);
        const card = state.cards.find(c => cardKey(c) === key);
        if (card) track('card.impression', card, { position: positionOf(card), pinned: !!card.pinned_at, ...feedContext() });
      }, 1000));
    }), { threshold: 0.5 });
    r.querySelectorAll('.aurora-feed-card').forEach(el => impressions.observer.observe(el));
  }
  // Links inside a card or its open detail view.
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    const cardEl = link.closest('.aurora-feed-card');
    const card = cardEl ? state.cards.find(c => cardKey(c) === `${cardEl.dataset.type}:${cardEl.dataset.id}`) : (link.closest('.aurora-modal') && state.openCard);
    if (!card) return;
    let host = '';
    try { host = new URL(link.href).host; } catch (_) { /* relative or malformed */ }
    // `kind` names a link Cardlake adds itself (add_to_calendar), so its use
    // can be told apart from links in the card's own content.
    const kind = link.dataset.linkKind ? { kind: link.dataset.linkKind } : {};
    track('card.link_click', card, { host, in_detail: !cardEl, position: positionOf(card), ...kind });
  }, true);
  const cardSearchText = card => [
    card.title, card.subtitle, card.body, card.metadata?.url, card.metadata?.external_url,
    card.metadata?.external_id, ...(Array.isArray(card.metadata?.labels) ? card.metadata.labels : []),
  ].filter(Boolean).join(' ').toLocaleLowerCase();
  // Integration-owned card types (GitHub issues, stored as 'kanban') get their
  // own chip group instead of a core chip, and are never created by hand: the
  // outside service owns them.
  const INTEGRATION_CARD_TYPES = new Set(['kanban']);
  const integrationCardTypes = () => new Set([...INTEGRATION_CARD_TYPES, ...state.integrations.map(i => i.card_type)]);
  const isLive = integration => integration.status === 'connected' || integration.status === 'error';
  const findIntegration = id => state.integrations.find(i => i.id === id);
  function creatableTypes() {
    const gated = integrationCardTypes();
    return Object.entries(TYPES).filter(([key]) => key !== 'file' && !gated.has(key));
  }
  // A signed-out visitor can still dismiss a card in the real (non-sandbox)
  // feed -- the server rejects the write with 401, so nothing is ever
  // persisted to the database, but the card stays hidden for the rest of
  // this browser session (sessionStorage, not localStorage: it clears when
  // the tab/browser closes, same as any other unauthenticated session state).
  const SESSION_DISMISSED_KEY = 'cardle-session-dismissed';
  function sessionDismissedSet() {
    try { return new Set(JSON.parse(sessionStorage.getItem(SESSION_DISMISSED_KEY) || '[]')); } catch (_) { return new Set(); }
  }
  function addSessionDismissed(card) {
    try {
      const set = sessionDismissedSet();
      set.add(cardKey(card));
      sessionStorage.setItem(SESSION_DISMISSED_KEY, JSON.stringify([...set]));
    } catch (_) { /* sessionStorage unavailable (private mode, etc.) -- the card just reappears on reload */ }
  }
  const IMAGE_URL_EXTENSION = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;
  const VIDEO_URL_EXTENSION = /\.(?:m4v|mov|mp4|webm)$/i;
  const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'youtube-nocookie.com']);
  const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  function mediaVisualsEnabled() {
    try { return localStorage.getItem(MEDIA_VISUALS_STORAGE_KEY) !== 'off'; } catch (_) { return true; }
  }
  function setMediaVisualsEnabled(enabled) {
    try { localStorage.setItem(MEDIA_VISUALS_STORAGE_KEY, enabled ? 'on' : 'off'); } catch (_) {}
  }
  function safeMediaUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
    try {
      const parsed = new URL(rawUrl.trim(), window.location.origin);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      return parsed;
    } catch (_) { return null; }
  }
  function youtubeVideoId(parsed) {
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!YOUTUBE_HOSTS.has(host)) return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    const candidate = host === 'youtu.be' ? segments[0] : (parsed.searchParams.get('v') || (['embed', 'shorts', 'live', 'v'].includes(segments[0]) ? segments[1] : null));
    return candidate && YOUTUBE_VIDEO_ID.test(candidate) ? candidate : null;
  }
  // A card whose whole title is a link (a reminder saved by pasting a YouTube
  // URL, say) is shown as a link card: a readable title, and the link
  // previewed like any other. Only the display changes; the stored title and
  // search keep the link.
  const BARE_LINK = /^https?:\/\/\S+$/i;
  function titleLink(card) {
    const title = String(card.title || '').trim();
    return BARE_LINK.test(title) ? safeMediaUrl(title) : null;
  }
  function titleOf(card) {
    const link = titleLink(card);
    if (!link) return card.title;
    return youtubeVideoId(link) ? 'YouTube video' : `Link from ${link.hostname.replace(/^(www|m)\./, '')}`;
  }
  function mediaSource(card) {
    const metadata = card.metadata || {}, attachments = Array.isArray(card.metadata?.attachments) ? card.metadata.attachments : [];
    const attachment = attachments.find(a => String(a.mime_type || '').startsWith('image/')) || attachments.find(a => String(a.mime_type || '').startsWith('video/'));
    if (attachment?.url) return { url: attachment.url, mime: attachment.mime_type, name: attachment.name || card.title, attachment: true };
    const url = metadata.url || metadata.blob_url;
    if (url) return { url, mime: metadata.mime_type, name: metadata.name || card.title };
    const link = titleLink(card);
    if (link) return { url: link.href, name: titleOf(card) };
    return null;
  }
  function mediaKind(card) {
    const source = mediaSource(card), parsed = source && safeMediaUrl(source.url);
    if (!parsed) return null;
    if (youtubeVideoId(parsed)) return { source, parsed, kind: 'youtube', label: 'Watch', icon: '▶' };
    if (String(source.mime || '').startsWith('image/') || IMAGE_URL_EXTENSION.test(parsed.pathname)) return { source, parsed, kind: 'image', label: 'Image', icon: '▧' };
    if (String(source.mime || '').startsWith('video/') || VIDEO_URL_EXTENSION.test(parsed.pathname)) return { source, parsed, kind: 'video', label: 'Video', icon: '▶' };
    return { source, parsed, kind: 'link', label: parsed.hostname.replace(/^www\./, '') || 'Link', icon: '↗' };
  }
  function mediaHtml(card) {
    const media = mediaKind(card);
    if (!media) return '';
    const { source, parsed } = media;
    const href = esc(parsed.href), videoId = youtubeVideoId(parsed);
    const host = parsed.hostname.replace(/^www\./, '') || 'Attachment';
    const context = esc(source.name || parsed.pathname.split('/').filter(Boolean).pop() || host);
    // Generated covers (covers.js) are drawn from the card itself, so they
    // load nothing from the linked site.
    const covers = window.CardleCovers?.coverHtml ? window.CardleCovers : null;
    if (videoId) {
      // The public demo loads nothing from other sites, so its video card gets a generated cover instead of YouTube's thumbnail.
      if (SANDBOX && covers) return covers.coverHtml(card, parsed, 'video', 'YouTube');
      const thumbnail = SANDBOX ? '' : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      return `<a class="aurora-card-media aurora-media-preview aurora-media-youtube" href="${href}" target="_blank" rel="noopener noreferrer" data-interactive aria-label="Watch ${context} on YouTube (opens in a new tab)">${thumbnail ? `<img src="${thumbnail}" alt="YouTube thumbnail for ${context}" loading="lazy" decoding="async">` : ''}<span class="aurora-media-play" aria-hidden="true">▶</span><span class="aurora-media-meta"><b>YouTube</b><span>${context}</span></span></a>`;
    }
    if (media.kind === 'image') return `<a class="aurora-card-media aurora-media-preview aurora-media-image" href="${href}" target="_blank" rel="noopener noreferrer" data-interactive aria-label="Open image ${context} in a new tab"><img src="${href}" alt="${source.attachment ? 'Attachment' : 'Linked image'}: ${context}" loading="lazy" decoding="async"><span class="aurora-media-meta"><b>Image</b><span>${context}</span></span></a>`;
    const isVideo = media.kind === 'video';
    const uploaded = !!source.attachment || card.type === 'file';
    // Video files get a player-like cover, other links a cover for reading or
    // revisiting. Cardlake's own uploaded files (PDFs and the like) keep the
    // plain cover below.
    if (covers && (isVideo || !uploaded)) return covers.coverHtml(card, parsed, isVideo ? 'video' : card.type === 'bookmark' ? 'bookmark' : 'article', isVideo && uploaded ? 'Uploaded video' : '');
    const label = isVideo ? 'Video' : host;
    return `<a class="aurora-card-media aurora-media-preview aurora-media-cover ${isVideo ? 'aurora-media-video' : 'aurora-media-link'}" href="${href}" target="_blank" rel="noopener noreferrer" data-interactive aria-label="Open ${context} in a new tab"><span class="aurora-media-art" aria-hidden="true">${isVideo ? '▶' : '↗'}</span>${isVideo ? '<span class="aurora-media-play" aria-hidden="true">▶</span>' : ''}<span class="aurora-media-meta"><b>${esc(label)}</b><span>${context}</span></span></a>`;
  }
  function mediaIndicatorHtml(card) {
    const media = mediaKind(card);
    if (!media) return '';
    const context = esc(media.source.name || media.parsed.pathname.split('/').filter(Boolean).pop() || media.parsed.hostname);
    return `<a class="aurora-media-indicator aurora-media-indicator-${media.kind}" href="${esc(media.parsed.href)}" target="_blank" rel="noopener noreferrer" data-interactive aria-label="${esc(media.label)}: ${context}"><span aria-hidden="true">${media.icon}</span>${esc(media.label)}</a>`;
  }
  // ---- Card state (option A) ----------------------------------------------
  // Motion that carries information: a reminder's ring drains toward its due
  // time and pulses once it's due today or overdue, a work checklist's bar
  // fills, a dealt card's bar shows its trial days left, and a GitHub issue
  // shows a status light. Shown whatever the Previews setting, because they
  // are information. covers.js plays each once and loops only on screen.
  const GITHUB_STATUS = { backlog: 'Open', in_progress: 'Assigned', done: 'Closed' };
  const pad2 = n => String(n).padStart(2, '0');
  const localDateKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  function reminderTiming(card) {
    const m = card.metadata || {};
    if (card.type !== 'reminder' || !m.due_date || m.completed) return null;
    const due = Date.parse(m.due_date), now = Date.now();
    if (!Number.isFinite(due)) return null;
    // A date without a time is stored as midnight UTC: compare it as a calendar day.
    const dueDay = /T00:00:00(\.000)?Z$/.test(m.due_date) ? m.due_date.slice(0, 10) : localDateKey(new Date(due));
    const urgent = dueDay <= localDateKey(new Date(now));
    const created = Date.parse(card.created_at);
    const span = Number.isFinite(created) && due > created ? due - created : 7 * DAY_MS;
    return { left: Math.min(1, Math.max(0, (due - now) / span)), urgent };
  }
  // The ring follows the badge's rounded square; pathLength makes it a percentage.
  function reminderRingHtml(timing) {
    if (!timing) return '';
    return `<svg class="cs-ring" viewBox="0 0 46 46" aria-hidden="true" focusable="false" style="--off:${Math.round(100 * (1 - timing.left))}"><rect class="cs-ring-track" x="1.5" y="1.5" width="43" height="43" rx="15" pathLength="100"/><rect class="cs-ring-fill" x="1.5" y="1.5" width="43" height="43" rx="15" pathLength="100"/></svg>`;
  }
  function workProgressHtml(card) {
    const m = card.metadata || {}, total = Number(m.total) || 0, done = Math.min(total, Number(m.done) || 0);
    if (card.type !== 'work' || !total) return '';
    return `<div class="cs-progress" role="img" aria-label="${done} of ${total} done"><i style="--p:${(done / total).toFixed(3)}"></i></div>`;
  }
  // GitHub issue cards carry their labels and a way back to the issue itself.
  // Cardlake sends no alerts, so a reminder with a due date offers to copy it
  // into Google Calendar, which does (calendar-link.js): a link in the detail
  // view, and a quieter one on the feed card. The demo feed has no account
  // behind it to link back to.
  function calendarLinkHtml(card, { inFeed = false } = {}) {
    if (SANDBOX) return '';
    const href = window.CardleCalendar?.googleCalendarUrl(card, { cardleUrl: `${location.origin}/vault/` });
    return href ? `<p class="aurora-calendar${inFeed ? ' aurora-calendar-feed' : ''}"><a class="aurora-calendar-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-interactive data-link-kind="add_to_calendar" aria-label="Add ${esc(titleOf(card))} to Google Calendar (opens in a new tab)">Add to Google Calendar ↗</a></p>` : '';
  }
  function issueMetaHtml(card) {
    if (!isGithubIssue(card)) return '';
    const url = safeMediaUrl(card.metadata.external_url);
    const labels = (card.metadata.labels || []).slice(0, 4).map(label => `<span class="aurora-issue-label">${esc(label)}</span>`).join('');
    const link = url ? `<a class="aurora-issue-link" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer" data-interactive aria-label="Open ${esc(titleOf(card))} on GitHub (opens in a new tab)">Open on GitHub ↗</a>` : '';
    // A status light: it pulses while the issue is assigned to you.
    const status = GITHUB_STATUS[card.metadata.status];
    const light = status ? `<span class="cs-status cs-status-${esc(card.metadata.status)}"><i aria-hidden="true"></i>${status}</span>` : '';
    return labels || link || light ? `<div class="aurora-issue-meta">${light}${labels}${link}</div>` : '';
  }
  const review = () => state.stats.review || { reviewed_today: 0, total_today: state.cards.length };
  // 0 is a real answer (a signed-out visitor, or a broken streak), not a gap to paper over.
  const streak = () => Number(state.stats.streak_days) || 0;
  function updateStreakBadge() { const el = document.getElementById('cardle-streak'); if (!el) return; el.querySelector('b').textContent = streak(); el.hidden = streak() < 1; }
  // The server counts streak days in the viewer's own calendar, not in UTC.
  function viewerTimeZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; } }
  const primaryLabel = card => TYPES[card.type]?.[3] || 'Review';
  const hasPrimaryAction = card => primaryLabel(card) !== 'Snooze';
  function feedUrl(more) { const p = new URLSearchParams({ limit: '20' }); if (state.view !== 'active') p.set('view', state.view); if (state.view === 'active') p.set('sort', state.sort); if (state.view === 'active' && state.favoritesOnly) p.set('liked', 'true'); if (state.filter !== 'all') p.set('types', state.filter); if (state.query) p.set('query', state.query); if (more && state.cursor) p.set('cursor', state.cursor); const tz = viewerTimeZone(); if (tz) p.set('tz', tz); return `/api/feed?${p}`; }
  function counts() { const map = { learning: 'learning_entries', kanban: 'kanban_items', work: 'work_items', family: 'family_updates', bookmark: 'bookmarks', talking_point: 'talking_points', reminder: 'reminders', file: 'files' }; return Object.fromEntries(Object.entries(map).map(([type, stat]) => [type, state.stats[stat] || 0])); }
  function formatDay(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr), now = new Date(), dayMs = 24 * 60 * 60 * 1000;
    const startOf = x => { const y = new Date(x); y.setHours(0, 0, 0, 0); return y; };
    const diff = Math.round((startOf(d) - startOf(now)) / dayMs);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff === -1) return 'yesterday';
    if (diff > 1 && diff < 7) return `in ${diff} days`;
    if (diff < -1 && diff > -7) return `${-diff} days ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function actionButtonsHtml(card) {
    if (state.view === 'snoozed') {
      const meta = `Back ${formatDay(card.remind_later_until)}`;
      const change = `<button type="button" data-snooze-change class="aurora-quiet" aria-label="Change when it comes back: ${esc(titleOf(card))}">Change</button>`;
      const bring = `<button type="button" data-bring-back class="aurora-action" aria-label="Bring back to feed now: ${esc(titleOf(card))}">↩ Bring back now</button>`;
      return `<div class="aurora-card-actions aurora-card-actions-recall"><span class="aurora-recall-meta">${esc(meta)}</span>${change}${bring}</div>`;
    }
    const dismiss = `<button type="button" data-dismiss class="aurora-quiet aurora-dismiss" aria-label="${dismissLabel(card)}: ${esc(titleOf(card))}"><span aria-hidden="true">←</span> ${dismissLabel(card)}</button>`;
    const remind = `<button type="button" data-remind class="aurora-action" aria-label="Snooze: ${esc(titleOf(card))}">Snooze <span aria-hidden="true">→</span></button>`;
    return `<div class="aurora-card-actions">${dismiss}${remind}</div>`;
  }
  // The viewer's local hour; the small hours count as evening.
  function greeting(hour) {
    if (hour >= 5 && hour < 12) return 'Good morning';
    if (hour >= 12 && hour < 17) return 'Good afternoon';
    return 'Good evening';
  }
  // The server labels due times in UTC because it can't know the reader's
  // zone ("Due 22 Sept 2026, 08:09 UTC"). The browser can, so a reminder's
  // time shows in the reader's own zone, and one that has passed says so
  // instead of only turning orange. Day-only dates are UTC midnight: a day.
  function subtitleOf(card, now = Date.now()) {
    const m = card.metadata || {};
    const due = m.due_date ? new Date(m.due_date) : null;
    if (card.type !== 'reminder' || !due || Number.isNaN(due.getTime())) return card.subtitle || '';
    const dayOnly = /T00:00:00(\.000)?Z$/.test(m.due_date);
    const sameYear = (dayOnly ? due.getUTCFullYear() : due.getFullYear()) === new Date(now).getFullYear();
    const label = due.toLocaleString(undefined, {
      day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
      ...(dayOnly ? { timeZone: 'UTC' } : { hour: 'numeric', minute: '2-digit' }),
    });
    const overdue = !m.completed && (dayOnly ? m.due_date.slice(0, 10) < localDateKey(new Date(now)) : due.getTime() < now);
    const text = overdue ? `Overdue, was due ${label}` : `Due ${label}`;
    return m.recurrence ? `${text}, repeats ${m.recurrence}` : text;
  }
  function cardHtml(card, index) {
    const type = TYPES[card.type] || TYPES.file, liked = !!card.liked_at, pinned = !!card.pinned_at;
    const mediaEnabled = mediaVisualsEnabled();
    const media = mediaEnabled ? mediaHtml(card) : '';
    const mediaIndicator = mediaEnabled ? '' : mediaIndicatorHtml(card);
    const recallView = state.view === 'snoozed';
    const pinLimitReached = !pinned && pinnedCount() >= maxPinned();
    const pinTitle = pinned ? 'Unpin' : pinLimitReached ? `Pin limit reached (${maxPinned()})` : 'Pin to top';
    const timing = reminderTiming(card), subtitle = subtitleOf(card);
    // Cards with no link get a faint pattern for their type while previews are on.
    const pattern = mediaEnabled && !media && window.CardleCovers ? window.CardleCovers.patternHtml(card.type) : '';
    const pinButton = recallView ? '' : `<button type="button" class="aurora-pin ${pinned ? 'is-pinned' : ''}" data-pin ${pinLimitReached ? 'disabled aria-disabled="true"' : ''} title="${esc(pinTitle)}" aria-label="${esc(pinTitle)}: ${esc(titleOf(card))}" aria-pressed="${pinned}">${PIN_ICON}</button>`;
    return `<article class="aurora-feed-card ${recallView ? 'aurora-feed-card-recall' : ''} ${state.justDealt.has(cardKey(card)) ? 'is-dealt' : ''}${timing?.urgent ? ' cs-urgent' : ''}" data-id="${esc(card.id)}" data-type="${esc(card.type)}" data-cc-key="${esc(cardKey(card))}" style="animation-delay:${index * 45}ms" ${recallView ? '' : `tabindex="0" aria-label="Open ${esc(titleOf(card))}. Swipe right to snooze, swipe left to ${dismissLabel(card).toLowerCase()}"`}>
      ${recallView ? '' : `<div class="aurora-swipe-bg aurora-swipe-right" aria-hidden="true">↘ Snooze</div><div class="aurora-swipe-bg aurora-swipe-left" aria-hidden="true">${repeats(card) ? 'Done ↙' : isGithubIssue(card) ? 'Remove ↙' : card.type === 'reminder' ? 'Complete ↙' : 'Delete ↙'}</div>`}
      <div class="aurora-card-inner">
        ${pattern}
        <div class="aurora-card-top"><span class="aurora-type-badge" style="background:${type[2]}">${type[0]}${reminderRingHtml(timing)}</span><div class="aurora-card-heading"><span>${type[1]}${subtitle ? `: ${esc(subtitle)}` : ''}</span><h3>${esc(titleOf(card))}</h3>${card.created_at ? `<small class="aurora-card-date">Added ${esc(formatDay(card.created_at))}</small>` : ''}${trialHtml(card)}</div>${pinButton}<button type="button" class="aurora-heart ${liked ? 'is-liked' : ''}" data-like aria-label="${liked ? 'Unlike' : 'Like'} ${esc(titleOf(card))}" aria-pressed="${liked}">♥</button></div>
        ${card.body ? `<p>${esc(card.body)}</p>` : ''}
        ${calendarLinkHtml(card, { inFeed: true })}
        ${workProgressHtml(card)}
        ${issueMetaHtml(card)}
        ${media}
        ${mediaIndicator}
        ${actionButtonsHtml(card)}
      </div>
    </article>`;
  }
  function pinnedSectionHtml(pinnedCards) {
    if (!pinnedCards.length) return '';
    const collapsed = pinnedCollapsed();
    return `<div class="aurora-pinned-section">
      <button type="button" class="aurora-pinned-toggle" data-pinned-toggle aria-expanded="${!collapsed}">
        <span class="aurora-pinned-toggle-label">${PIN_ICON}<span>Pinned</span><b>${pinnedCards.length}/${maxPinned()}</b></span>
        <span class="aurora-pinned-chevron ${collapsed ? 'is-collapsed' : ''}" aria-hidden="true">⌄</span>
      </button>
      <div class="aurora-pinned-list" ${collapsed ? 'hidden' : ''}>${pinnedCards.map((card, i) => cardHtml(card, i)).join('')}</div>
    </div>`;
  }
  function listHtml() {
    if (!state.cards.length) return emptyStateHtml();
    if (state.view !== 'active') return state.cards.map(cardHtml).join('');
    const pinned = state.cards.filter(c => c.pinned_at);
    // Cards just dealt go first, so the deal lands where the reader is looking.
    const unpinned = state.cards.filter(c => !c.pinned_at);
    const rest = [...unpinned.filter(c => state.justDealt.has(cardKey(c))), ...unpinned.filter(c => !state.justDealt.has(cardKey(c)))];
    return pinnedSectionHtml(pinned) + rest.map((card, i) => cardHtml(card, pinned.length + i)).join('') + dealPromptHtml();
  }
  // ---- Deal me 5 (api/_lib/surprise.js) -----------------------------------
  // Five fresh cards for a thin feed. Offered in the feed header, on the empty
  // feed, under a feed of fewer than THIN_FEED cards, and in the new-card
  // sheet. Dealt and starter cards are on trial: the feed shows how long each
  // has unless it's kept.
  const THIN_FEED = 10;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const surpriseReady = () => !SANDBOX && state.surprise?.available === true;
  const onMainFeed = () => state.view === 'active' && !state.favoritesOnly && !state.query && state.filter === 'all';
  // The server allows a few deals a day (DEALS_PER_DAY in surprise.js); the
  // buttons say how many are left so the limit isn't a surprise.
  function dealsLeftText(left) {
    if (left <= 0) return 'No deals left today';
    return `${left} deal${left === 1 ? '' : 's'} left today`;
  }
  function dealButtonHtml() {
    const surprise = state.surprise;
    if (surprise.unseen === 0) return '<button type="button" class="aurora-deal" disabled>You’ve seen them all. New cards soon</button>';
    if (surprise.dealsLeftToday === 0) return '<button type="button" class="aurora-deal" disabled>Come back tomorrow for more</button>';
    return `<button type="button" class="aurora-deal" data-deal>Deal me 5 <span class="aurora-deal-count">(${dealsLeftText(surprise.dealsLeftToday)})</span></button>`;
  }
  // The header copy sits beside New card on every main-feed visit, so a full
  // feed can still ask for something new. It stays visible when it can't
  // deal, and says why, rather than jumping in and out of the header.
  function headerDealHtml() {
    if (!surpriseReady() || state.view !== 'active') return '';
    const surprise = state.surprise;
    const label = 'Deal<span class="aurora-deal-me"> me</span> 5';
    const reason = surprise.unseen === 0 ? 'You’ve seen them all. New cards soon' : surprise.dealsLeftToday === 0 ? 'Come back tomorrow for more' : '';
    if (reason) return `<button type="button" class="aurora-deal aurora-header-deal" disabled title="${reason}" aria-label="Deal me 5: ${reason}">${label}</button>`;
    const left = dealsLeftText(surprise.dealsLeftToday);
    return `<button type="button" class="aurora-deal aurora-header-deal" data-deal title="${left}" aria-label="Deal me 5 fresh cards (${left})">${label}<b class="aurora-deal-left" aria-hidden="true">${surprise.dealsLeftToday}</b></button>`;
  }
  const changeTopicsHtml = () => (state.surprise?.interests ? '<button type="button" class="aurora-quiet aurora-deal-topics" data-deal-topics>Change topics</button>' : '');
  function dealPromptHtml() {
    if (!surpriseReady() || !onMainFeed() || state.cursor || state.cards.length >= THIN_FEED) return '';
    return `<section class="aurora-deal-prompt" aria-label="Deal me 5"><div><b>Feed feeling quiet?</b><span>Get five fresh videos and ideas from topics you like.</span></div><div class="aurora-deal-actions">${dealButtonHtml()}${changeTopicsHtml()}</div></section>`;
  }
  function trialHtml(card) {
    const trial = state.surprise?.trials?.find(t => t.type === card.type && t.id === card.id);
    if (!trial || card.liked_at || card.pinned_at) return '';
    const days = Math.max(1, Math.ceil((Date.parse(trial.expiresAt) - Date.now()) / DAY_MS));
    const label = `${trial.kind === 'sample' ? 'Sample' : 'Dealt'}, ${days} day${days === 1 ? '' : 's'} left`;
    const share = Math.min(1, days / (Number(state.surprise?.trialDays) || 14));
    return `<small class="aurora-card-trial" title="Like or pin it to keep it"><i class="cs-life" aria-hidden="true"><b style="--p:${share.toFixed(3)}"></b></i>${esc(label)}</small>`;
  }
  async function loadSurprise() {
    if (SANDBOX) return;
    try { state.surprise = await V.api('/api/surprise'); } catch (_) { state.surprise = null; return; }
    if (surpriseReady()) render();
  }
  function startDeal(button) {
    if (!state.surprise?.interests) return openTopicPicker();
    return runDeal(undefined, button);
  }
  function openTopicPicker() {
    const surprise = state.surprise;
    const selected = new Set(surprise.interests || surprise.suggestedTopics || []);
    const chips = surprise.topics.map(topic => `<button type="button" class="aurora-chip ${selected.has(topic.id) ? 'active' : ''}" data-topic="${esc(topic.id)}" aria-pressed="${selected.has(topic.id)}">${esc(topic.name)}</button>`).join('');
    const node = modal(`<h2>What are you curious about?</h2><p>Pick a few topics. Each deal brings four fresh videos or articles from them, plus one small thing to try. Cards you don’t like or pin clear themselves after ${esc(surprise.trialDays)} days.</p><div class="aurora-topic-grid" role="group" aria-label="Topics">${chips}</div><div class="aurora-modal-actions"><button type="button" class="aurora-new" data-topics-deal>Deal me 5</button><button type="button" class="aurora-action" data-topics-skip>Skip, surprise me</button></div>`, 'aurora-capture');
    node.querySelectorAll('[data-topic]').forEach(chip => chip.onclick = () => {
      const on = !selected.has(chip.dataset.topic);
      if (on) selected.add(chip.dataset.topic); else selected.delete(chip.dataset.topic);
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-pressed', String(on));
    });
    const go = (topics, button) => runDeal(topics, button).then(ok => { if (ok) node.closeModal(); });
    node.querySelector('[data-topics-deal]').onclick = e => go([...selected], e.currentTarget);
    node.querySelector('[data-topics-skip]').onclick = e => go([], e.currentTarget);
  }
  async function runDeal(topics, button) {
    const label = button?.innerHTML;
    if (button) { button.disabled = true; button.textContent = 'Dealing…'; }
    try {
      const result = await V.api('/api/surprise', { method: 'POST', body: JSON.stringify(topics === undefined ? {} : { topics }) });
      state.justDealt = new Set(result.cards.map(cardKey));
      state.view = 'active'; state.favoritesOnly = false; state.query = ''; state.filter = 'all'; state.cursor = null;
      toast(`Dealt ${result.dealt} fresh card${result.dealt === 1 ? '' : 's'}. ${dealsLeftText(result.dealsLeftToday)}`);
      await loadSurprise();
      await load(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return true;
    } catch (err) {
      if (err && err.status === 401) V.showLogin(() => runDeal(topics));
      else toast(err?.message || 'Could not deal cards');
      if (err?.code === 'DEAL_LIMIT' || err?.code === 'NOTHING_LEFT') loadSurprise();
      return false;
    } finally {
      if (button?.isConnected) { button.disabled = false; button.innerHTML = label; }
    }
  }
  function supportLinkHtml() {
    return `<a class="aurora-support-link" href="/support.html"${SANDBOX ? ' target="_top"' : ''}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"></path><path d="M12 17h.01"></path></svg>Help</a>`;
  }
  function shell() {
    const count = counts(), active = state.filter, progress = review(), ratio = progress.total_today ? progress.reviewed_today / progress.total_today : 1;
    const gated = integrationCardTypes();
    const chips = [['all', 'All'], ...Object.entries(TYPES).filter(([key]) => key !== 'file' && !gated.has(key)).map(([key, value]) => [key, value[1]])].map(([key, label]) => `<button type="button" class="aurora-chip ${active === key ? 'active' : ''}" data-filter="${key}" aria-pressed="${active === key}">${label}</button>`).join('') + integrationChipsHtml();
    const likedCount = Number(state.stats.liked_cards || 0), mediaEnabled = mediaVisualsEnabled();
    const snoozedCount = Number(state.stats.snoozed_count || 0);
    // The hint names the view you're in; the main feed needs none, and a
    // line of filler there only made the pinned controls taller.
    const hint = state.view === 'snoozed' ? 'Cards you snoozed. Bring one back whenever you like.'
      : state.favoritesOnly ? 'Showing your liked cards' : '';
    // Snoozed cards are always listed by when they come back, so sorting is a main-feed control.
    const sortControl = state.view === 'active' ? `<div class="aurora-sort" role="group" aria-label="Sort cards"><span class="aurora-sort-label" aria-hidden="true">Sort</span>${SORTS.map(([key, label, title]) => `<button type="button" class="aurora-sort-option ${state.sort === key ? 'is-active' : ''}" data-sort="${key}" aria-pressed="${state.sort === key}" title="${esc(title)}">${key === 'ai' ? '<span aria-hidden="true">✦</span> ' : ''}${label}</button>`).join('')}</div>` : '';
    const views = `<div class="aurora-feed-views" aria-label="Feed views"><button type="button" class="aurora-view-toggle ${state.favoritesOnly ? 'is-active' : ''}" data-favorites-toggle aria-pressed="${state.favoritesOnly}"${hint ? ' aria-describedby="aurora-favorites-hint"' : ''}><span aria-hidden="true">♥</span><span>Favorites</span><b data-favorites-count>${likedCount}</b></button><button type="button" class="aurora-view-toggle ${state.view === 'snoozed' ? 'is-active' : ''}" data-recall-toggle="snoozed" aria-pressed="${state.view === 'snoozed'}"><span aria-hidden="true">⏰</span><span>Snoozed</span><b>${snoozedCount}</b></button><button type="button" class="aurora-view-toggle aurora-media-toggle ${mediaEnabled ? 'is-active' : ''}" data-media-visuals-toggle aria-pressed="${mediaEnabled}" aria-label="Turn media previews ${mediaEnabled ? 'off' : 'on'}"><span aria-hidden="true">◈</span><span>Previews</span><b>${mediaEnabled ? 'On' : 'Off'}</b></button>${sortControl}${hint ? `<span class="aurora-view-hint" id="aurora-favorites-hint">${hint}</span>` : ''}</div>`;
    const headerTitle = state.view === 'snoozed' ? 'Snoozed' : state.query ? 'Search results' : 'Your feed';
    const headerSub = state.query ? `For “${esc(state.query)}”` : state.view === 'active' ? greeting(new Date().getHours()) : `${state.cards.length} card${state.cards.length === 1 ? '' : 's'}`;
    const headerActions = state.view === 'active'
      ? `${state.query ? `<button type="button" class="aurora-search" data-clear-search aria-label="Clear feed search">${CLOSE_ICON}</button>` : ''}<button type="button" class="aurora-search" data-search aria-label="Search feed">${SEARCH_ICON}</button>${headerDealHtml()}<button type="button" class="aurora-new" data-capture aria-label="Create a new card">+ <span>New card</span></button>`
      : '<button type="button" class="aurora-search" data-back-to-feed aria-label="Back to feed">←</button>';
    const progressBlock = state.view === 'active' ? `<div class="aurora-progress"><i style="width:${ratio * 100}%"></i></div><p class="aurora-progress-label">${progress.reviewed_today}/${progress.total_today} reviewed today</p>` : '';
    // target="_top": the demo may be shown inside an iframe, and a plain link
    // would open the app inside that frame instead of the full page.
    const sandboxBanner = SANDBOX ? `<div class="aurora-sandbox-banner">Live demo: try delete, snooze &amp; favorite. <a href="/vault/index.html?signin=1" target="_top">Sign in</a> to save your own.</div>` : '';
    const quota = state.stats.quota || {};
    const warnings = [['cards', 'card limit'], ['text_storage', 'text storage'], ['file_storage', 'file storage']].filter(([key]) => quota[key]?.warning).map(([, label]) => label);
    const quotaNotice = warnings.length ? `<p class="aurora-quota-notice" role="status">You are nearing your ${esc(warnings.join(' and '))}. Delete older cards or files to make room.</p>` : '';
    // The controls stay pinned under the app header (.aurora-feed-top in
    // aurora-feed.css) so filtering or adding a card never means scrolling
    // back up; notices scroll away with the cards.
    return `<section class="aurora-feed" aria-label="Your feed">${sandboxBanner}<div class="aurora-main"><div class="aurora-feed-top"><header class="aurora-feed-header"><div><small>${headerSub}</small><h2>${headerTitle}</h2>${SANDBOX ? supportLinkHtml() : ''}</div><div class="aurora-header-actions">${headerActions}</div></header><div class="aurora-chips" aria-label="Filter cards">${chips}</div>${views}${progressBlock}</div>${quotaNotice}${integrationBarHtml()}<div class="aurora-list"></div><div class="aurora-sentinel"></div></div></section>`;
  }
  // Set-up integrations filter like any chip; the rest invite setup. A "New"
  // tag stays on a freshly set-up integration until its chip is first used.
  function integrationChipsHtml() {
    if (!state.integrations.length) return '';
    const chips = state.integrations.map(integration => {
      const name = esc(integration.name);
      if (!isLive(integration)) {
        const label = integration.status === 'onboarding' ? `Finish setting up ${integration.name}` : `Set up ${integration.name}`;
        return `<button type="button" class="aurora-chip aurora-chip-integration is-setup" data-integration-setup="${esc(integration.id)}" aria-label="${esc(label)}"><span aria-hidden="true">+</span>${name}</button>`;
      }
      const type = TYPES[integration.card_type] || TYPES.file, isActive = state.filter === integration.card_type, isNew = !integration.acknowledged;
      const error = integration.status === 'error';
      const label = `${integration.name}${error ? ', needs attention' : ''}${isNew ? ', new' : ''}`;
      return `<button type="button" class="aurora-chip aurora-chip-integration ${isActive ? 'active' : ''} ${isNew ? 'is-new' : ''}" data-filter="${esc(integration.card_type)}" data-integration="${esc(integration.id)}" aria-label="${esc(label)}" aria-pressed="${isActive}"${error ? ` title="${esc(integration.last_sync_error || 'Last sync failed')}"` : ''}>${type[0]}<span>${name}</span><i class="aurora-chip-status ${error ? 'is-error' : ''}" aria-hidden="true"></i>${isNew ? '<em class="aurora-chip-new" aria-hidden="true">New</em>' : ''}</button>`;
    }).join('');
    return `<span class="aurora-chip-group" role="group" aria-label="Integrations"><span class="aurora-chip-divider" aria-hidden="true"></span>${chips}${COMING_SOON_INTEGRATIONS.map(comingSoonChipHtml).join('')}</span>`;
  }
  // Announced but not built yet (Email: issue #142). Not a button and has no
  // data-filter, so it can't be clicked into a setup flow that doesn't exist.
  const COMING_SOON_INTEGRATIONS = [{ name: 'Email', hint: 'Forward emails to Cardlake to turn them into cards' }];
  function comingSoonChipHtml({ name, hint }) {
    return `<span class="aurora-chip aurora-chip-integration is-soon" role="note" title="${esc(hint)} (coming soon)" aria-label="${esc(name)}, coming soon">${esc(name)}<em class="aurora-chip-soon" aria-hidden="true">Soon</em></span>`;
  }
  // Filtering to a connected integration shows what it is connected to and
  // how fresh it is, with "Sync now" and "Manage" one tap away.
  function integrationBarHtml() {
    const integration = state.view === 'active' && state.integrations.find(i => i.card_type === state.filter && isLive(i));
    if (!integration || !window.CardleIntegrations) return '';
    const type = TYPES[integration.card_type] || TYPES.file, error = integration.status === 'error';
    const actions = SANDBOX ? '' : `<button type="button" class="aurora-integration-sync" data-integration-sync="${esc(integration.id)}">Sync now</button><button type="button" class="aurora-integration-manage" data-integration-manage="${esc(integration.id)}">Manage</button>`;
    return `<section class="aurora-integration-bar ${error ? 'is-error' : ''}" aria-label="${esc(integration.name)}"><span class="aurora-integration-bar-icon" aria-hidden="true">${type[0]}</span><div class="aurora-integration-bar-text"><b>${esc(integration.repo || integration.name)}</b><small ${error ? 'role="status"' : ''}>${esc(window.CardleIntegrations.statusLine(integration))}</small></div><div class="aurora-integration-bar-actions">${actions}</div></section>`;
  }
  async function syncIntegration(button) {
    const integration = findIntegration(button.dataset.integrationSync);
    if (!integration) return;
    button.disabled = true;
    button.textContent = 'Syncing…';
    try {
      const result = await window.CardleIntegrations.sync(integration);
      toast(`Synced ${result.synced} ${result.synced === 1 ? 'issue' : 'issues'}`);
    } catch (err) {
      if (err && err.status === 401) { V.showLogin(() => syncIntegration(button)); return; }
      toast(err?.message || 'Sync failed');
    }
    state.cursor = null;
    load(false);
  }
  function manageIntegration(id) {
    const integration = findIntegration(id);
    if (!integration) return;
    window.CardleIntegrations.manage(integration, {
      onChanged: what => {
        if (what === 'disconnected') { toast(`${integration.name} disconnected`); state.filter = 'all'; }
        state.cursor = null;
        load(false);
      },
    });
  }
  // Keeps GitHub issues fresh without a cron (Vercel Hobby only allows daily
  // ones): after the feed renders, any connected integration whose last sync
  // is older than AUTO_SYNC_AFTER_MS syncs in the background. At most one
  // attempt per integration per interval per browser session, so a broken
  // token doesn't retry on every load. The feed reloads only if the reader is
  // at the top with nothing open -- never yanked out from under them.
  const AUTO_SYNC_AFTER_MS = 15 * 60e3;
  const AUTO_SYNC_KEY = 'cardle-auto-sync';
  function autoSyncAttempts() {
    try { return JSON.parse(sessionStorage.getItem(AUTO_SYNC_KEY) || '{}'); } catch (_) { return {}; }
  }
  function autoSyncDue(integration) {
    if (!isLive(integration)) return false;
    const lastSync = Date.parse(integration.last_synced_at || '') || 0;
    const lastAttempt = Number(autoSyncAttempts()[integration.id] || 0);
    return Date.now() - Math.max(lastSync, lastAttempt) > AUTO_SYNC_AFTER_MS;
  }
  function markAutoSyncAttempt(id) {
    try { sessionStorage.setItem(AUTO_SYNC_KEY, JSON.stringify({ ...autoSyncAttempts(), [id]: Date.now() })); } catch (_) { /* no session storage: at worst one extra attempt per load */ }
  }
  async function autoSync() {
    const due = state.integrations.filter(autoSyncDue);
    if (SANDBOX || !due.length || !window.CardleIntegrations || !(await V.checkAuth())) return;
    let synced = false;
    for (const integration of due) {
      markAutoSyncAttempt(integration.id);
      try { await window.CardleIntegrations.sync(integration); synced = true; } catch (_) { /* recorded server-side; the bar shows it on the next load */ }
    }
    if (synced && window.scrollY < 120 && !document.querySelector('.aurora-overlay')) { state.cursor = null; load(false); }
  }
  function acknowledge(integration) {
    if (!integration || integration.acknowledged || SANDBOX) return;
    integration.acknowledged = true;
    V.api(`/api/integrations/${encodeURIComponent(integration.id)}/acknowledge`, { method: 'POST' }).catch(() => { /* the tag just shows again next load */ });
  }
  async function startIntegrationSetup(id) {
    const integration = findIntegration(id);
    if (!integration || !window.CardleIntegrations) return;
    if (!(await V.checkAuth())) {
      // Signing in can switch tenants, so reload before deciding where setup resumes.
      V.showLogin(async () => { await load(false); startIntegrationSetup(id); });
      return;
    }
    window.CardleIntegrations.open(integration, {
      onFinished: (next, view) => {
        toast(`${integration.name} is set up`);
        if (next === 'filter') { acknowledge({ ...integration, ...view }); state.filter = integration.card_type; }
        state.cursor = null;
        load(false);
      },
    });
  }
  function emptyStateHtml() {
    if (state.query) return `<section class="aurora-empty"><div aria-hidden="true">${SEARCH_ICON}</div><h3>No matching cards</h3><p>Try another title, note, label, or link.</p><button type="button" class="aurora-view-toggle" data-clear-search>Clear search</button></section>`;
    if (state.view === 'snoozed') return `<section class="aurora-empty aurora-recall-empty"><div aria-hidden="true">⏰</div><h3>Nothing snoozed</h3><p>Cards you snooze show up here until they come back on their own.</p><button type="button" class="aurora-view-toggle" data-back-to-feed>Back to feed</button></section>`;
    if (state.favoritesOnly) return `<section class="aurora-empty aurora-favorites-empty"><div aria-hidden="true">♡</div><h3>No favorites yet</h3><p>Save cards with the heart to find them here.</p><button type="button" class="aurora-view-toggle" data-favorites-toggle>Browse feed</button></section>`;
    if (onMainFeed() && vaultIsEmpty()) return startEmptyHtml();
    const deal = surpriseReady() && onMainFeed() ? `<p>Or get something new: five fresh cards from topics you like.</p><div class="aurora-deal-actions">${dealButtonHtml()}${changeTopicsHtml()}</div>` : '';
    return `<section class="aurora-empty"><div>✓</div><h3>All caught up</h3><p>${streak() > 0 ? `Streak day ${streak()} is locked in. ` : ''}Come back tomorrow for more.</p>${deal}</section>`;
  }
  // No cards at all, snoozed ones included: a new account that chose an empty
  // feed, or one that cleared everything. "All caught up" would tell them to
  // come back tomorrow before they've added anything, so say how to start.
  const vaultIsEmpty = () => Object.values(counts()).every(n => !Number(n)) && !Number(state.stats.snoozed_count);
  function startEmptyHtml() {
    const deal = surpriseReady() ? `<p>Or tap <b>Deal me 5</b> for five fresh videos and ideas from topics you like.</p>` : '';
    return `<section class="aurora-empty aurora-start-empty"><div aria-hidden="true">+</div><h3>Your feed is empty</h3><p>Add your first card, or ask Claude or ChatGPT to save something for you.</p>${deal}<div class="aurora-deal-actions"><button type="button" class="aurora-new" data-empty-capture>+ New card</button>${surpriseReady() ? dealButtonHtml() + changeTopicsHtml() : ''}</div></section>`;
  }
  function render() { const r = root(); if (!r) return; r.innerHTML = shell(); updateStreakBadge(); const list = r.querySelector('.aurora-list'); list.innerHTML = listHtml(); bind(r); observe(r); observeImpressions(r); }
  // `days` is only for 'remind_later': how long the snooze lasts (one day if left out).
  async function feedAction(card, action, days) {
    if (SANDBOX) {
      const target = sandboxAllCards().find(c => c.id === card.id);
      if (target) sandboxApplyAction(target, action, days);
      return {};
    }
    // keepalive: a removal still waiting for Undo is sent as the page closes.
    return V.api('/api/feed', { method: 'POST', keepalive: true, body: JSON.stringify({ action, item_type: card.type, item_id: card.id, ...(days ? { days } : {}) }) });
  }
  // How long a snooze can last, as api/feed.js allows (MAX_SNOOZE_DAYS).
  const MAX_SNOOZE_DAYS = 365;
  const snoozeDaysInputHtml = (value = 1) => `<input type="number" name="snooze_days" min="1" max="${MAX_SNOOZE_DAYS}" step="1" value="${value}" inputmode="numeric" required>`;
  // A whole number of days the server will accept, or null.
  function snoozeDaysFrom(input) {
    const days = Number(input.value);
    return Number.isInteger(days) && days >= 1 && days <= MAX_SNOOZE_DAYS ? days : null;
  }
  // Whole days left on a snooze, at least one: what "Change" starts from.
  const snoozeDaysLeft = card => Math.max(1, Math.ceil((new Date(card.remind_later_until) - Date.now()) / 86400e3));
  // Snoozed view: set how many days from now a snoozed card comes back.
  function changeSnooze(card) {
    const node = modal(`<h2>When should it come back?</h2><form data-snooze-edit><label class="aurora-capture-label">Days from now (1 to ${MAX_SNOOZE_DAYS})${snoozeDaysInputHtml(snoozeDaysLeft(card))}</label><div class="aurora-modal-actions"><button type="submit" class="aurora-new">Save</button></div></form>`, 'aurora-capture');
    const form = node.querySelector('[data-snooze-edit]');
    const input = form.elements.snooze_days;
    requestAnimationFrame(() => input.select());
    form.onsubmit = event => {
      event.preventDefault();
      const days = snoozeDaysFrom(input);
      if (!days) { toast(`Choose 1 to ${MAX_SNOOZE_DAYS} days.`); return; }
      const save = () => feedAction(card, 'remind_later', days);
      const done = () => { node.closeModal(); toast(`Back in ${days} day${days === 1 ? '' : 's'}`); load(false); };
      save().then(done).catch(err => {
        if (err && err.status === 401) { V.showLogin(() => save().then(done).catch(() => toast('Could not update card'))); } else { toast(err?.message || 'Could not update card'); }
      });
    };
  }
  // Completing a reminder marks it done rather than deleting it: it leaves the
  // feed but is kept, so an assistant can still find and reopen it. For a
  // recurring one the server also moves it to its next due date and snoozes it
  // until then. "Stop repeating" in the detail view is the dismiss that deletes
  // it. Every other card's dismiss deletes it.
  function dismissCard(card) {
    if (card.type !== 'reminder' || SANDBOX) return feedAction(card, 'dismiss');
    return V.api(`/api/reminders/${card.id}`, { method: 'PATCH', keepalive: true, body: JSON.stringify({ completed: true }) });
  }
  async function primary(card) {
    if (card.type === 'reminder') return V.api(`/api/reminders/${card.id}`, { method: 'PATCH', body: JSON.stringify({ completed: true }) });
    if (card.type === 'learning') return V.api(`/api/learnings/${card.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'watched' }) });
    if (card.type === 'kanban') return window.open(card.metadata?.external_url || '#', '_blank', 'noopener');
    if (card.type === 'bookmark') return window.open(card.metadata?.url || '#', '_blank', 'noopener');
    if (card.type === 'file') return window.open(card.metadata?.blob_url || `/api/feed?file_id=${card.id}`, '_blank', 'noopener');
    return feedAction(card, 'remind_later');
  }
  // A card leaving the feed (snoozed, completed or deleted) waits UNDO_MS
  // before the server hears about it, with Undo in the toast: a delete can't be
  // reversed server-side, and a mis-swipe on a phone is easy. One removal waits
  // at a time; starting another, or leaving the page, sends the waiting one.
  const UNDO_MS = 5000;
  let pendingRemoval = null;
  function flushPendingRemoval() {
    const pending = pendingRemoval;
    if (!pending) return;
    pendingRemoval = null;
    clearTimeout(pending.timer);
    pending.toast.remove();
    pending.commit();
  }
  window.addEventListener('pagehide', flushPendingRemoval);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushPendingRemoval(); });
  // What the toast says happened; a snooze says when the card comes back.
  function removalMessage(card, action, days) {
    if (action === 'remind_later') return days > 1 ? `Snoozed for ${days} days` : 'Snoozed until tomorrow';
    if (action === 'stop') return 'Reminder deleted';
    if (repeats(card)) return 'Done until it’s next due';
    if (isGithubIssue(card)) return 'Removed from Cardlake';
    return card.type === 'reminder' ? 'Reminder completed' : 'Card deleted';
  }
  function undoToast(message, onUndo) {
    document.querySelectorAll('.aurora-toast').forEach(node => node.remove());
    const node = document.createElement('div');
    node.className = 'aurora-toast aurora-undo-toast';
    node.setAttribute('role', 'status');
    node.innerHTML = `<span>${esc(message)}</span><button type="button" data-undo>Undo</button>`;
    node.querySelector('[data-undo]').onclick = onUndo;
    document.body.appendChild(node);
    return node;
  }
  // `action` is 'remind_later' (for `days`, one if left out), 'dismiss'
  // (complete or delete, see dismissCard) or 'stop' (delete a recurring reminder).
  function removeAfterFeedAction(card, el, action, days) {
    flushPendingRemoval();
    const key = cardKey(card);
    const index = state.cards.findIndex(c => cardKey(c) === key);
    // A dismissed recurring reminder is snoozed until it's next due.
    const statKey = action === 'remind_later' || (action === 'dismiss' && repeats(card)) ? 'snoozed_count' : null;
    // Favorites counts only cards in the feed, as the server does, so a liked
    // card leaving it leaves the count too.
    const wasLiked = !!card.liked_at;
    // Snoozing or deleting a card also unpins it on the server, freeing its slot.
    const wasPinned = !!card.pinned_at;
    const run = () => (action === 'dismiss' ? dismissCard(card) : action === 'stop' ? feedAction(card, 'dismiss') : feedAction(card, action, days));
    state.cards = state.cards.filter(c => cardKey(c) !== key);
    if (statKey) state.stats[statKey] = Number(state.stats[statKey] || 0) + 1;
    if (wasLiked) state.stats.liked_cards = Math.max(0, Number(state.stats.liked_cards || 0) - 1);
    if (wasPinned) state.stats.pinned_cards = Math.max(0, pinnedCount() - 1);
    if (el) { el.classList.add('is-leaving'); setTimeout(render, 280); } else render();
    // Puts the card back where it was, leaving any other change since alone.
    const restore = () => {
      if (index >= 0 && !state.cards.some(c => cardKey(c) === key)) state.cards.splice(Math.min(index, state.cards.length), 0, card);
      if (statKey) state.stats[statKey] = Math.max(0, Number(state.stats[statKey] || 0) - 1);
      if (wasLiked) state.stats.liked_cards = Number(state.stats.liked_cards || 0) + 1;
      if (wasPinned) state.stats.pinned_cards = pinnedCount() + 1;
      render();
    };
    const commit = () => run().catch(err => {
      if (action === 'dismiss' && err && err.status === 401) { addSessionDismissed(card); return; }
      restore();
      if (err && err.status === 401) { V.showLogin(() => run().then(() => load(false)).catch(() => toast('Could not update card'))); } else { toast('Could not update card'); }
    });
    const pending = { key, commit };
    pending.toast = undoToast(removalMessage(card, action, days), () => {
      if (pendingRemoval !== pending) return;
      pendingRemoval = null;
      clearTimeout(pending.timer);
      pending.toast.remove();
      restore();
    });
    pending.timer = setTimeout(() => { if (pendingRemoval === pending) flushPendingRemoval(); }, UNDO_MS);
    pendingRemoval = pending;
  }
  function bringBack(card, el) {
    const before = state.cards.slice();
    const action = 'unremind_later';
    const statKey = 'snoozed_count';
    const wasLiked = !!card.liked_at;
    state.cards = state.cards.filter(c => cardKey(c) !== cardKey(card));
    state.stats[statKey] = Math.max(0, Number(state.stats[statKey] || 0) - 1);
    if (wasLiked) state.stats.liked_cards = Number(state.stats.liked_cards || 0) + 1;
    el.classList.add('is-leaving'); setTimeout(render, 280);
    feedAction(card, action).then(() => toast('Back in your feed')).catch(err => {
      state.cards = before;
      state.stats[statKey] = Number(state.stats[statKey] || 0) + 1;
      if (wasLiked) state.stats.liked_cards = Math.max(0, Number(state.stats.liked_cards || 0) - 1);
      render();
      if (err && err.status === 401) { V.showLogin(() => feedAction(card, action).then(() => { toast('Back in your feed'); load(false); }).catch(() => toast('Could not update card'))); } else { toast('Could not update card'); }
    });
  }
  function like(card, button) { const old = !!card.liked_at; card.liked_at = old ? null : new Date().toISOString(); button.classList.toggle('is-liked', !old); button.setAttribute('aria-pressed', String(!old)); feedAction(card, old ? 'unlike' : 'like').then(() => load(false)).catch(err => { card.liked_at = old ? new Date().toISOString() : null; render(); if (err && err.status === 401) { V.showLogin(() => feedAction(card, old ? 'unlike' : 'like').then(() => load(false)).catch(() => toast('Could not save card'))); } else { toast('Could not save card'); } }); }
  function pin(card) {
    const old = !!card.pinned_at;
    if (!old && pinnedCount() >= maxPinned()) { toast(`You can only pin up to ${maxPinned()} cards. Unpin one first.`); return; }
    card.pinned_at = old ? null : new Date().toISOString();
    state.stats.pinned_cards = Math.max(0, pinnedCount() + (old ? -1 : 1));
    render();
    feedAction(card, old ? 'unpin' : 'pin').then(() => load(false)).catch(err => {
      card.pinned_at = old ? new Date().toISOString() : null;
      state.stats.pinned_cards = Math.max(0, pinnedCount() + (old ? 1 : -1));
      render();
      if (err && err.status === 401) { V.showLogin(() => feedAction(card, old ? 'unpin' : 'pin').then(() => load(false)).catch(() => toast('Could not update card'))); } else { toast(err?.message || 'Could not update card'); }
    });
  }
  // A new filter or view is a new list. The controls stay pinned while you
  // scroll, so without this you'd land partway down the new list.
  function showListFromTop() { if (window.scrollY > 0) window.scrollTo({ top: 0 }); }
  function bind(r) {
    r.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { acknowledge(findIntegration(b.dataset.integration)); state.filter = b.dataset.integration && state.filter === b.dataset.filter ? 'all' : b.dataset.filter; state.cursor = null; track('feed.filter', null, feedContext()); showListFromTop(); load(false); });
    r.querySelectorAll('[data-integration-setup]').forEach(b => b.onclick = () => startIntegrationSetup(b.dataset.integrationSetup));
    r.querySelector('[data-integration-sync]')?.addEventListener('click', e => syncIntegration(e.currentTarget));
    r.querySelector('[data-integration-manage]')?.addEventListener('click', e => manageIntegration(e.currentTarget.dataset.integrationManage));
    r.querySelectorAll('[data-favorites-toggle]').forEach(b => b.onclick = () => { state.favoritesOnly = !state.favoritesOnly; state.view = 'active'; state.cursor = null; track('feed.view', null, feedContext()); showListFromTop(); load(false); });
    r.querySelectorAll('[data-recall-toggle]').forEach(b => b.onclick = () => { const target = b.dataset.recallToggle; state.view = state.view === target ? 'active' : target; state.favoritesOnly = false; state.cursor = null; track('feed.view', null, feedContext()); showListFromTop(); load(false); });
    r.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => { if (state.sort === b.dataset.sort) return; state.sort = b.dataset.sort; saveSort(state.sort); state.cursor = null; track('feed.sort', null, feedContext()); showListFromTop(); load(false); });
    r.querySelectorAll('[data-back-to-feed]').forEach(b => b.onclick = () => { state.view = 'active'; state.cursor = null; track('feed.view', null, feedContext()); showListFromTop(); load(false); });
    r.querySelector('[data-media-visuals-toggle]')?.addEventListener('click', () => { setMediaVisualsEnabled(!mediaVisualsEnabled()); track('settings.change', null, { media_visuals: mediaVisualsEnabled() }); render(); });
    r.querySelector('[data-pinned-toggle]')?.addEventListener('click', () => { setPinnedCollapsed(!pinnedCollapsed()); track('settings.change', null, { pinned_collapsed: pinnedCollapsed() }); render(); });
    r.querySelector('[data-capture]')?.addEventListener('click', SANDBOX ? sandboxSignInGate : () => capture());
    r.querySelector('[data-empty-capture]')?.addEventListener('click', SANDBOX ? sandboxSignInGate : () => capture());
    r.querySelector('[data-search]')?.addEventListener('click', openSearch);
    r.querySelectorAll('[data-deal]').forEach(b => b.onclick = () => startDeal(b));
    r.querySelectorAll('[data-deal-topics]').forEach(b => b.onclick = openTopicPicker);
    r.querySelectorAll('[data-clear-search]').forEach(b => b.onclick = () => { state.query = ''; state.cursor = null; track('feed.search', null, { query: null, cleared: true }); load(false); });
    const recallView = state.view === 'snoozed';
    r.querySelectorAll('.aurora-feed-card').forEach(el => {
      const card = state.cards.find(c => cardKey(c) === `${el.dataset.type}:${el.dataset.id}`);
      el.querySelector('[data-like]').onclick = e => { e.stopPropagation(); like(card, e.currentTarget); };
      el.querySelector('[data-pin]')?.addEventListener('click', e => { e.stopPropagation(); pin(card); });
      if (recallView) {
        el.querySelector('[data-bring-back]')?.addEventListener('click', e => { e.stopPropagation(); bringBack(card, el); });
        el.querySelector('[data-snooze-change]')?.addEventListener('click', e => { e.stopPropagation(); changeSnooze(card); });
        return;
      }
      let suppressClick = false;
      const isSwipeBlockedTarget = target => target.closest('a, button, [data-interactive], [data-like]');
      el.addEventListener('click', e => {
        if (!suppressClick) return;
        e.preventDefault();
        e.stopPropagation();
        suppressClick = false;
      }, true);
      el.onclick = e => { if (!suppressClick && !e.target.closest('button,a,[data-interactive]')) detail(card); };
      el.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
          e.preventDefault();
          detail(card);
        }
      });
      el.querySelector('[data-remind]').onclick = e => { e.stopPropagation(); removeAfterFeedAction(card, el, 'remind_later'); };
      el.querySelector('[data-dismiss]').onclick = e => { e.stopPropagation(); removeAfterFeedAction(card, el, 'dismiss'); };
      // swipe handling
      let startX = 0, startY = 0, currentX = 0, swiping = false;
      const resetSwipe = () => {
        startX = startY = currentX = 0;
        swiping = false;
        el.classList.remove('swiping', 'remind-preview', 'dismiss-preview');
        el.style.removeProperty('--aurora-swipe-x');
      };
      el.addEventListener('pointerdown', e => {
        if (isSwipeBlockedTarget(e.target)) return;
        startX = e.clientX;
        startY = e.clientY;
        currentX = 0;
        swiping = true;
        el.setPointerCapture?.(e.pointerId);
      });
      el.addEventListener('pointermove', e => {
        if (!swiping) return;
        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;
        if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 18) {
          resetSwipe();
          return;
        }
        if (Math.abs(deltaX) > 8) e.preventDefault();
        currentX = Math.max(-SWIPE_MAX_DRAG, Math.min(SWIPE_MAX_DRAG, deltaX));
        el.style.setProperty('--aurora-swipe-x', `${currentX}px`);
        el.classList.add('swiping');
        el.classList.toggle('remind-preview', currentX > SWIPE_THRESHOLD / 2);
        el.classList.toggle('dismiss-preview', currentX < -SWIPE_THRESHOLD / 2);
      });
      el.addEventListener('pointerup', e => {
        const deltaX = currentX || 0;
        resetSwipe();
        if (deltaX > SWIPE_THRESHOLD) {
          suppressClick = true;
          e.preventDefault();
          removeAfterFeedAction(card, el, 'remind_later');
          setTimeout(() => { suppressClick = false; }, 350);
        }
        if (deltaX < -SWIPE_THRESHOLD) {
          suppressClick = true;
          e.preventDefault();
          removeAfterFeedAction(card, el, 'dismiss');
          setTimeout(() => { suppressClick = false; }, 350);
        }
      });
      el.addEventListener('pointercancel', resetSwipe);
    });
    r.querySelectorAll('[data-open]').forEach(b => b.onclick = () => detail(state.cards.find(c => cardKey(c) === b.dataset.open)));
  }
  function observe(r) { state.observer?.disconnect(); const target = r.querySelector('.aurora-sentinel'); if (!state.cursor) return; state.observer = new IntersectionObserver(entries => { if (entries[0].isIntersecting) load(true); }, { rootMargin: '300px' }); state.observer.observe(target); }
  // The explicit first-card choice reuses the editor after the feed loads.
  // Consume the request so closing the editor or refreshing won't reopen it.
  function openRequestedCapture() {
    if (SANDBOX) return;
    const url = new URL(location.href);
    if (url.searchParams.get('welcome') !== '1' || url.searchParams.get('capture') !== 'reminder') return;
    url.searchParams.delete('capture');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    // A link shared before sign-in is already the user's first item to save.
    if (window.CardleShare?.pending()) return;
    capture('reminder');
  }
  async function load(more) {
    if (state.loading) return; state.loading = true;
    try {
      if (!more) {
        const contextKey = JSON.stringify(feedContext());
        if (contextKey !== impressions.contextKey) { impressions.seen.clear(); impressions.contextKey = contextKey; }
      }
      // A removal waiting for Undo hasn't reached the server yet, so a reload
      // would otherwise bring the card straight back.
      const waiting = pendingRemoval?.key;
      if (SANDBOX) { state.cards = sandboxVisibleCards().filter(c => cardKey(c) !== waiting); state.stats = sandboxStats(); state.integrations = sandboxIntegrations(); state.cursor = null; }
      else {
        const data = await V.api(feedUrl(more));
        const dismissed = sessionDismissedSet();
        const cards = (data.cards || []).filter(c => !dismissed.has(cardKey(c)) && cardKey(c) !== waiting);
        if (more) state.cards.push(...cards); else { state.cards = cards; state.stats = data.stats || {}; state.integrations = data.integrations || []; }
        state.cursor = data.next_cursor;
      }
      render();
      if (!more) autoSync();
      if (!more && !state.surprise) loadSurprise();
      if (!more) openRequestedCapture();
      if (!more) offerSharedLink();
    } catch (error) { root().innerHTML = `<section class="aurora-error"><p role="alert">${esc(error?.message || 'Could not load your feed.')}</p>${supportLinkHtml()}</section>`; } finally { state.loading = false; }
  }
  function modal(content, className, onClose) {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = document.createElement('div');
    node.className = `aurora-overlay ${className || ''}`;
    node.innerHTML = `<div class="aurora-modal" role="dialog" aria-modal="true"><button type="button" class="aurora-close" aria-label="Close">×</button>${content}</div>`;
    document.body.appendChild(node);
    const dialog = node.querySelector('.aurora-modal');
    const heading = dialog.querySelector('h2');
    if (heading) {
      heading.id ||= `aurora-dialog-title-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      dialog.setAttribute('aria-labelledby', heading.id);
    }
    const closeButton = node.querySelector('.aurora-close');
    const close = () => { node.remove(); onClose?.(); opener?.focus?.({ preventScroll: true }); };
    const focusable = () => [...dialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(el => !el.hidden && el.getClientRects().length);
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const targets = focusable();
      if (!targets.length) { event.preventDefault(); dialog.tabIndex = -1; dialog.focus(); return; }
      const first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    closeButton.onclick = close;
    node.onclick = event => { if (event.target === node) close(); };
    closeButton.focus();
    node.closeModal = close;
    return node;
  }
  function openSearch() {
    const node = modal(`<h2>Search feed</h2><form data-feed-search><label class="aurora-capture-label">Search titles, notes, labels, and links<input type="search" name="query" value="${esc(state.query)}" maxlength="100" autocomplete="off"></label><div class="aurora-modal-actions"><button type="submit" class="aurora-new">Search</button>${state.query ? '<button type="button" class="aurora-action" data-search-clear>Clear</button>' : ''}</div></form>`, 'aurora-capture');
    const form = node.querySelector('[data-feed-search]');
    const input = form.elements.query;
    requestAnimationFrame(() => input.focus());
    form.onsubmit = event => {
      event.preventDefault();
      state.query = String(input.value || '').trim().slice(0, 100);
      state.cursor = null;
      track('feed.search', null, { query: state.query || null });
      node.closeModal();
      load(false);
    };
    node.querySelector('[data-search-clear]')?.addEventListener('click', () => {
      state.query = '';
      state.cursor = null;
      track('feed.search', null, { query: null, cleared: true });
      node.closeModal();
      load(false);
    });
  }
  // Editing a card reuses the new-card fields for its type, filled with what
  // the card says now. Only changed fields are sent, so a reminder's time of
  // day (which an assistant can set, but the date field can't show) survives
  // an edit that doesn't touch the date. GitHub issues are edited on GitHub,
  // and a file card has nothing to edit.
  const EDIT_ENDPOINT = { learning: '/api/learnings', work: '/api/work', family: '/api/family', bookmark: '/api/bookmarks', talking_point: '/api/talking-points', reminder: '/api/reminders' };
  const canEdit = card => !!EDIT_ENDPOINT[card.type];
  // A due date as the date field shows it: midnight UTC is a date-only
  // reminder; any other time is shown on the viewer's own calendar day.
  function dueDateInputValue(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    if (date.toISOString().endsWith('T00:00:00.000Z')) return date.toISOString().slice(0, 10);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  // The card's current values, keyed as captureValues reads the form.
  function editValues(card) {
    const meta = card.metadata || {};
    if (card.type === 'reminder') return { title: card.title || '', due_date: dueDateInputValue(meta.due_date), recurrence: meta.recurrence || '' };
    if (card.type === 'learning' || card.type === 'bookmark') return { title: card.title || '', url: meta.url || '', notes: card.body || '' };
    if (card.type === 'work') return { title: card.title || '', items_text: (meta.items || []).map(item => (typeof item === 'object' ? item.text : item) || '').filter(Boolean).join('\n') };
    if (card.type === 'family') return { person: card.title || '', content: card.body || '' };
    if (card.type === 'talking_point') return { title: card.title || '', content: card.body || '' };
    return {};
  }
  // What to PATCH: the fields that differ from `before`, under the API's names.
  function editChanges(type, before, after) {
    const changes = {};
    for (const [key, value] of Object.entries(after)) {
      if (value === before[key]) continue;
      if (key === 'items_text') changes.items = String(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      else if (type === 'talking_point' && key === 'title') changes.section_title = value;
      else changes[key] = value;
    }
    return changes;
  }
  function editCard(card) {
    const before = editValues(card);
    const node = modal(`<h2>Edit card</h2><form data-edit-form><p class="aurora-capture-error" data-edit-error role="alert"></p><div data-capture-fields>${captureFields(card.type)}</div><button class="aurora-new">Save changes</button></form>`, 'aurora-capture');
    const fields = node.querySelector('[data-capture-fields]');
    // Attachments are added when a card is created.
    fields.querySelector('input[name="attachment"]')?.closest('label')?.remove();
    restoreCaptureValues(fields, before);
    requestAnimationFrame(() => fields.querySelector('input, textarea')?.focus());
    const form = node.querySelector('[data-edit-form]');
    const setError = message => { node.querySelector('[data-edit-error]').textContent = message || ''; };
    form.onsubmit = async event => {
      event.preventDefault();
      setError('');
      if (!form.reportValidity()) return;
      const changes = editChanges(card.type, before, captureValues(fields));
      if (!Object.keys(changes).length) { node.closeModal(); return; }
      const save = () => V.api(`${EDIT_ENDPOINT[card.type]}/${card.id}`, { method: 'PATCH', body: JSON.stringify(changes) });
      const done = () => { node.closeModal(); toast('Card updated'); load(false); };
      try {
        await save();
        done();
      } catch (err) {
        if (err && err.status === 401) V.showLogin(() => save().then(done).catch(error => setError(error?.message || 'Could not save changes.')));
        else setError(err?.message || 'Could not save changes. Please try again.');
      }
    };
  }
  function detail(card) {
    if (!card) return;
    const openedAt = Date.now();
    state.openCard = card;
    track('card.open', card, { position: positionOf(card), ...feedContext() });
    const onClose = () => { state.openCard = null; track('card.close', card, { dwell_ms: Date.now() - openedAt }); };
    const type = TYPES[card.type] || TYPES.file, subtitle = subtitleOf(card);
    const pinLimitReached = !card.pinned_at && pinnedCount() >= maxPinned();
    const pinTitle = card.pinned_at ? 'Unpin' : pinLimitReached ? `Pin limit reached (${maxPinned()})` : 'Pin to top';
    const editButton = canEdit(card) ? `<button type="button" class="aurora-edit" data-detail-edit aria-label="Edit ${esc(titleOf(card))}">Edit</button>` : '';
    const node = modal(`${editButton}<span class="aurora-type-badge big" style="background:${type[2]}">${type[0]}</span><small>${type[1]}${subtitle ? `: ${esc(subtitle)}` : ''}</small><h2>${esc(titleOf(card))}</h2><p>${esc(card.body || '')}</p>${calendarLinkHtml(card)}${issueMetaHtml(card)}${mediaHtml(card)}<div class="aurora-modal-actions aurora-card-actions"><button type="button" data-detail-dismiss class="aurora-quiet aurora-dismiss" aria-label="${dismissLabel(card)}: ${esc(titleOf(card))}"><span aria-hidden="true">←</span> ${dismissLabel(card)}</button><button type="button" data-detail-remind class="aurora-action" aria-label="Snooze: ${esc(titleOf(card))}">Snooze <span aria-hidden="true">→</span></button><button type="button" data-detail-pin class="aurora-pin ${card.pinned_at ? 'is-pinned' : ''}" ${pinLimitReached ? 'disabled aria-disabled="true"' : ''} aria-label="${esc(pinTitle)}: ${esc(titleOf(card))}" aria-pressed="${!!card.pinned_at}" title="${esc(pinTitle)}">${PIN_ICON}</button><button type="button" data-detail-like class="aurora-heart ${card.liked_at ? 'is-liked' : ''}" aria-label="${card.liked_at ? 'Unlike' : 'Like'} ${esc(titleOf(card))}" aria-pressed="${!!card.liked_at}">♥</button>${repeats(card) ? `<button type="button" data-detail-stop class="aurora-quiet" aria-label="Stop repeating: ${esc(titleOf(card))}">Stop repeating</button>` : ''}</div><label class="aurora-snooze-days">Snooze for ${snoozeDaysInputHtml()} days</label>`, undefined, onClose);
    // The detail view's actions take the same path as the card's own buttons,
    // so they get the same Undo (and the same retry after signing in again).
    const leave = (action, days) => {
      node.closeModal();
      const el = root()?.querySelector(`[data-cc-key="${CSS.escape(cardKey(card))}"]`);
      removeAfterFeedAction(card, el, action, days);
    };
    node.querySelector('[data-detail-dismiss]').onclick = () => leave('dismiss');
    node.querySelector('[data-detail-remind]').onclick = () => {
      const input = node.querySelector('[name="snooze_days"]');
      const days = snoozeDaysFrom(input);
      if (!days) { toast(`Choose 1 to ${MAX_SNOOZE_DAYS} days.`); input.focus(); return; }
      leave('remind_later', days);
    };
    const stop = node.querySelector('[data-detail-stop]');
    if (stop) stop.onclick = () => leave('stop');
    node.querySelector('[data-detail-edit]')?.addEventListener('click', () => { node.closeModal(); if (SANDBOX) sandboxSignInGate(); else editCard(card); });
    node.querySelector('[data-detail-pin]').onclick = e => { pin(card); e.currentTarget.classList.toggle('is-pinned', !!card.pinned_at); e.currentTarget.setAttribute('aria-pressed', String(!!card.pinned_at)); };
    node.querySelector('[data-detail-like]').onclick = e => like(card, e.currentTarget);
  }
  const CAPTURE_SINGULAR_KEY = { learning: 'entry', kanban: 'item', work: 'item', family: 'update', bookmark: 'bookmark', talking_point: 'talking_point', reminder: 'reminder' };
  const quotaLimit = (key, fallback) => Number(state.stats?.quota?.[key]?.limit || fallback);
  const formatBytes = bytes => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) ? 1 : 0)} MB` : `${Math.ceil(bytes / 1024)} KB`;
  const ATTACHMENT_FIELD = () => `<label class="aurora-capture-label">Attach a file (optional, up to ${formatBytes(quotaLimit('file_size', 4 * 1024 * 1024))})<input name="attachment" type="file" accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.txt,.md,.json,.docx,.xlsx"><small>JPG, PNG, GIF, WebP, PDF, TXT, MD, JSON, DOCX or XLSX.</small></label>`;
  function captureFields(type) { const titleMax = quotaLimit('title', 200); const contentMax = quotaLimit('content', 50000); if (type === 'family') return `<label class="aurora-capture-label">Person<input name="person" required maxlength="${titleMax}"></label><label class="aurora-capture-label">Update<textarea name="content" required maxlength="${contentMax}"></textarea></label>${ATTACHMENT_FIELD()}`; if (type === 'talking_point') return `<label class="aurora-capture-label">Title<input name="section_title" required maxlength="${titleMax}"></label><label class="aurora-capture-label">Notes<textarea name="content" required maxlength="${contentMax}"></textarea></label>${ATTACHMENT_FIELD()}`; if (type === 'file') return '<label class="aurora-capture-label">File<input name="file" type="file" accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.txt,.md,.json,.docx,.xlsx" required><small>JPG, PNG, GIF, WebP, PDF, TXT, MD, JSON, DOCX or XLSX.</small></label>'; return `<label class="aurora-capture-label">${type === 'bookmark' ? 'Title' : 'What do you want to remember?'}<input name="title" required maxlength="${titleMax}"></label>${type === 'bookmark' ? `<label class="aurora-capture-label">URL (optional)<input name="url" type="url"></label><label class="aurora-capture-label">Notes (optional)<textarea name="notes" maxlength="${contentMax}"></textarea></label>` : ''}${type === 'learning' ? `<label class="aurora-capture-label">URL (optional)<input name="url" type="url"></label><label class="aurora-capture-label">Notes (optional)<textarea name="notes" maxlength="${contentMax}" placeholder="Where it's from, why it's worth it"></textarea></label>` : ''}${type === 'work' ? `<label class="aurora-capture-label">Checklist (one item per line)<textarea name="items_text" maxlength="${contentMax}"></textarea></label>` : ''}${type === 'reminder' ? '<label class="aurora-capture-label">Due date (optional)<input name="due_date" type="date"></label><label class="aurora-capture-label">Repeats<select name="recurrence"><option value="">Never</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>' : ''}${ATTACHMENT_FIELD()}`; }
  // Switching card type re-renders the form; what was typed carries over to
  // fields of the same name. A Misc card's title is its section_title.
  const CAPTURE_SHARED_FIELD = { section_title: 'title' };
  const captureFieldKey = name => CAPTURE_SHARED_FIELD[name] || name;
  function captureValues(fields) {
    const values = {};
    fields.querySelectorAll('input[name]:not([type="file"]), textarea[name], select[name]').forEach(field => { values[captureFieldKey(field.name)] = field.value; });
    return values;
  }
  function restoreCaptureValues(fields, values) {
    fields.querySelectorAll('input[name]:not([type="file"]), textarea[name], select[name]').forEach(field => {
      const value = values[captureFieldKey(field.name)];
      if (value !== undefined) field.value = value;
    });
  }
  // A Work card's checklist, typed one item per line.
  const checklistItems = text => String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(text => ({ text, completed: false }));
  async function uploadAttachment(parentType, parentId, file) {
    const data = new FormData();
    data.append('file', file);
    data.append('parent_type', parentType);
    data.append('parent_id', parentId);
    return V.api('/api/feed', { method: 'POST', body: data });
  }
  // Quick add (smart-capture.js) guesses the type and fields from one line of
  // text; this says what it guessed, so the person can check before saving.
  const quickDay = iso => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  function quickHint(type, values, picked) {
    const label = TYPES[type]?.[1] || type;
    if (picked) return `Saving as ${label}, the type you picked.`;
    const items = type === 'work' ? checklistItems(values.items_text).length : 0;
    const details = [
      values.due_date && type === 'reminder' ? `due ${quickDay(values.due_date)}` : '',
      values.recurrence && type === 'reminder' ? `repeats ${values.recurrence}` : '',
      items ? `${items} checklist item${items === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(', ');
    return `Looks like a ${label}${details ? `: ${details}` : ''}. Not right? Pick another type.`;
  }
  // prefill (a link shared from another app) starts the form filled in;
  // onClose runs however the dialog closes, saved or not.
  function capture(initialType, prefill = {}, onClose) {
    const creatable = creatableTypes();
    let type = creatable.some(([key]) => key === initialType) ? initialType : 'reminder';
    track('capture.open', null, { type });
    const tiles = creatable.map(([key, x]) => `<button type="button" role="radio" aria-checked="${key === type}" data-capture-type="${key}" class="aurora-capture-type">${x[0]}<span>${x[1]}</span></button>`).join('');
    const smart = window.CardleSmartCapture;
    const quickBox = smart ? `<label class="aurora-capture-label aurora-quick-add">Quick add<textarea data-quick-add rows="2" maxlength="${quotaLimit('content', 50000)}" placeholder="Call mum every Sunday, paste a link, or list steps one per line"></textarea></label><p class="aurora-quick-hint" data-quick-hint aria-live="polite"></p>` : '';
    const node = modal(`<h2>New card</h2>${quickBox}<small>TYPE</small><div class="aurora-type-grid" role="radiogroup" aria-label="Card type">${tiles}</div><form data-capture-form><p class="aurora-capture-error" data-capture-error role="alert"></p><div data-capture-fields>${captureFields(type)}</div><button class="aurora-new">Save card</button></form>${surpriseReady() ? `<div class="aurora-capture-deal"><span>Not sure what to add?</span>${dealButtonHtml()}</div>` : ''}`, 'aurora-capture', onClose);
    const setError = message => { node.querySelector('[data-capture-error]').textContent = message || ''; };
    const assertFileSize = file => { if (file?.size > quotaLimit('file_size', 4 * 1024 * 1024)) throw new Error(`Each file must be ${formatBytes(quotaLimit('file_size', 4 * 1024 * 1024))} or smaller.`); };
    const typed = { ...prefill };
    let keptAttachment = null;
    // guessed: the fields quick add filled, applied over what's in the form.
    const refresh = (guessed = {}) => {
      setError('');
      const fields = node.querySelector('[data-capture-fields]');
      Object.assign(typed, captureValues(fields), guessed);
      const attachment = fields.querySelector('input[name="attachment"]');
      if (attachment) keptAttachment = attachment.files.length ? attachment : null;
      fields.innerHTML = captureFields(type);
      restoreCaptureValues(fields, typed);
      const slot = fields.querySelector('input[name="attachment"]');
      if (slot && keptAttachment) slot.replaceWith(keptAttachment);
      node.querySelectorAll('[data-capture-type]').forEach(x => {
        const selected = x.dataset.captureType === type;
        x.classList.toggle('selected', selected);
        x.setAttribute('aria-checked', String(selected));
      });
    };
    restoreCaptureValues(node.querySelector('[data-capture-fields]'), typed);
    refresh();
    const quick = node.querySelector('[data-quick-add]');
    const hint = node.querySelector('[data-quick-hint]');
    // Once the person picks a type themselves, quick add stops changing it.
    let guessedType = null;
    let typePicked = false;
    const prefilled = Object.values(prefill).some(Boolean);
    requestAnimationFrame(() => (quick && !prefilled ? quick : node.querySelector('[data-capture-fields] input:not([type="file"]), [data-capture-fields] textarea, [data-capture-fields] select'))?.focus());
    node.querySelector('[data-deal]')?.addEventListener('click', () => { node.closeModal(); startDeal(); });
    node.querySelectorAll('[data-capture-type]').forEach(button => button.onclick = () => {
      type = button.dataset.captureType;
      if (quick?.value.trim()) typePicked = true;
      refresh();
      if (guessedType) hint.textContent = quickHint(type, typed, typePicked && type !== guessedType);
    });
    quick?.addEventListener('input', () => {
      const guess = smart.draftFromText(quick.value, { titleMax: quotaLimit('title', 200), contentMax: quotaLimit('content', 50000) });
      guessedType = guess && creatable.some(([key]) => key === guess.type) ? guess.type : null;
      if (guessedType && !typePicked) type = guessedType;
      refresh(guess ? guess.values : Object.fromEntries(smart.QUICK_KEYS.map(key => [key, ''])));
      hint.textContent = guessedType ? quickHint(type, typed, typePicked && type !== guessedType) : '';
    });
    // Enter starts a new checklist line; Ctrl/Cmd+Enter saves.
    quick?.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); node.querySelector('[data-capture-form]').requestSubmit(); }
    });
    node.querySelector('[data-capture-form]').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      setError('');
      if (!form.reportValidity()) return;
      try {
        if (type === 'file') {
          const file = form.elements.file.files[0];
          assertFileSize(file);
          const data = new FormData(); data.append('file', file);
          await V.api('/api/feed', { method: 'POST', body: data });
        } else {
          const formData = new FormData(form);
          const attachmentFile = formData.get('attachment');
          formData.delete('attachment');
          assertFileSize(attachmentFile);
          const values = Object.fromEntries(formData);
          const endpoint = { learning: '/api/learnings', kanban: '/api/kanban', work: '/api/work', family: '/api/family', bookmark: '/api/bookmarks', talking_point: '/api/talking-points', reminder: '/api/reminders' }[type];
          if (type === 'learning') { values.status = 'saved'; values.category = 'others'; }
          if (type === 'work') { values.items = checklistItems(values.items_text); delete values.items_text; }
          const created = await V.api(endpoint, { method: 'POST', body: JSON.stringify(values) });
          const newId = created?.[CAPTURE_SINGULAR_KEY[type]]?.id;
          if (attachmentFile instanceof File && attachmentFile.size > 0 && newId) {
            try {
              const upload = await uploadAttachment(type, newId, attachmentFile);
              if (upload?.warning) toast(upload.warning);
            } catch (error) {
              node.closeModal();
              toast(`Card saved, but the attachment was not uploaded: ${error.message}`);
              load(false);
              return;
            }
          }
        }
        // How often the guess was kept is what says whether quick add works.
        if (guessedType) track('capture.quick_add', null, { guessed: guessedType, saved: type });
        node.closeModal();
        toast('Card added to your feed');
        load(false);
      } catch (err) {
        if (err && err.status === 401) V.showLogin(() => node.querySelector('[data-capture-form]')?.requestSubmit());
        else setError(err?.message || 'Could not add card. Please try again.');
      }
    };
  }
  // A link shared to the installed app from another app (share-target.js)
  // opens as a pre-filled new card once the feed is up and the person is
  // signed in; signed out, it waits through sign-in. Nothing saves until they
  // press Save, so a forwarded message never lands in the feed unseen.
  let shareOpen = false;
  async function offerSharedLink() {
    const share = !SANDBOX && !shareOpen && window.CardleShare?.pending();
    if (!share) return;
    shareOpen = true; // before the await, so a second feed load can't open it twice
    if (!(await V.checkAuth())) { shareOpen = false; return; }
    const draft = window.CardleShare.shareDraft(share, { titleMax: quotaLimit('title', 200), contentMax: quotaLimit('content', 50000) });
    capture(draft.type, draft.values, () => { shareOpen = false; window.CardleShare.clear(); });
  }
  function sandboxSignInGate() {
    modal(`<h2>Sign in to add your own cards</h2><p>This is a live demo feed, so nothing here is saved. Sign in to start your real feed and add cards that stick.</p><a class="aurora-new" href="/vault/index.html?signin=1" target="_top" style="display:inline-flex;align-items:center;justify-content:center;text-decoration:none;margin-top:8px;">Sign in and continue</a>`, 'aurora-capture');
  }
  function toast(message) { const node = document.createElement('div'); node.className = 'aurora-toast'; node.textContent = message; document.body.appendChild(node); setTimeout(() => node.remove(), 2200); }
  window.addEventListener('storage', event => { if (event.key === MEDIA_VISUALS_STORAGE_KEY && root()) render(); });
  window.CardleTabs = window.CardleTabs || {}; window.CardleTabs.overview = () => load(false);
}());
