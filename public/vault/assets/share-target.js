// "Share to Cardlake" from another app (Android's share sheet; manifest
// share_target). The installed app opens /vault/index.html?title=&text=&url=,
// and the feed offers the shared link as a pre-filled new card.
//
// This runs before vault.js so the share is set aside before anything can
// redirect: a signed-out app is sent to welcome.html to sign in, and onboarding
// may run first, so the share waits in sessionStorage (this tab only) until the
// feed opens it. The feed clears it once the new-card dialog closes, saved or not.
(function (root) {
  'use strict';
  const SHARE_PARAMS = ['title', 'text', 'url'];
  const STORAGE_KEY = 'cardle-pending-share';
  // Messaging apps (WhatsApp among them) send the link inside `text` and leave
  // `url` empty. Trailing punctuation belongs to the sentence, not the link.
  const LINK_IN_TEXT = /https?:\/\/[^\s<>"]+/i;
  const TRAILING_PUNCTUATION = /[.,;:!?)\]'"]+$/;
  const webUrl = value => (/^https?:\/\/\S+$/i.test(value) ? value : '');

  function parseShare(search) {
    const params = new URLSearchParams(search);
    if (!SHARE_PARAMS.some(name => params.has(name))) return null;
    const [title, text, url] = SHARE_PARAMS.map(name => (params.get(name) || '').trim());
    return title || text || url ? { title, text, url } : null;
  }

  // What the new-card dialog starts with: a Bookmark when there's a link,
  // otherwise a Misc card holding the text. The values carry over if the
  // person picks another type (Learn keeps the notes, Misc the content).
  function shareDraft(share, { titleMax = 200, contentMax = 50000 } = {}) {
    const found = share.text.match(LINK_IN_TEXT);
    const url = webUrl(share.url) || (found ? found[0].replace(TRAILING_PUNCTUATION, '') : '');
    // The link (with its stray punctuation) comes out of the text, which keeps the rest.
    const linkText = webUrl(share.url) || (found ? found[0] : '');
    const rest = (linkText ? share.text.split(linkText).join(' ') : share.text).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    const firstLine = rest.split('\n')[0];
    const title = (share.title || firstLine || url).slice(0, titleMax);
    const notes = rest === title ? '' : rest.slice(0, contentMax);
    return {
      type: url ? 'bookmark' : 'talking_point',
      values: { title, url, notes, content: (rest || title).slice(0, contentMax) },
    };
  }

  function store(share) {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(share)); } catch (_) { /* storage blocked: offered on this page load only */ }
  }
  let current = null;
  function pending() {
    try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') || current; } catch (_) { return current; }
  }
  function clear() {
    current = null;
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) { /* storage blocked */ }
  }

  // Take the share out of the address so a reload or Back doesn't offer it twice.
  function captureIncoming(location, history) {
    const share = parseShare(location.search);
    if (!share) return;
    current = share;
    store(share);
    const params = new URLSearchParams(location.search);
    SHARE_PARAMS.forEach(name => params.delete(name));
    const query = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  }

  const api = { parseShare, shareDraft, pending, clear };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  captureIncoming(root.location, root.history);
  root.CardleShare = api;
}(typeof window !== 'undefined' ? window : globalThis));
