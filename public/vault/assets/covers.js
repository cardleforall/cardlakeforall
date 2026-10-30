// Generated covers for link cards, shown when the feed's media previews are on.
// Each cover is drawn in the browser from the card's own URL, title and save
// date, so nothing is downloaded from the linked site (unlike a link preview,
// which copies the site's image and tells it who is looking). The style
// follows what the link is for:
//   video    -> Signal: a player with a waveform and a moving playhead
//   article  -> Editorial: the title's two most distinctive words, set big
//   bookmark -> Postcard: a stamp, postmarked with the site and the save date
// aurora-feed.js calls CardleCovers.coverHtml(); YouTube links and images keep
// their real thumbnail instead.
(function () {
  'use strict';

  // Cardlake's blue-violet family, each with one accent. The site picks the
  // palette, so every post from one site shares its colours.
  const PALETTES = [
    { dark: 'oklch(28% .09 272)', mid: 'oklch(52% .17 262)', light: 'oklch(82% .08 250)', accent: 'oklch(82% .14 80)', paper: 'oklch(96% .018 260)' },
    { dark: 'oklch(30% .07 232)', mid: 'oklch(58% .13 222)', light: 'oklch(87% .06 205)', accent: 'oklch(74% .15 35)', paper: 'oklch(96% .02 220)' },
    { dark: 'oklch(28% .09 312)', mid: 'oklch(55% .16 302)', light: 'oklch(85% .07 320)', accent: 'oklch(84% .13 165)', paper: 'oklch(96% .018 320)' },
    { dark: 'oklch(29% .06 168)', mid: 'oklch(55% .11 160)', light: 'oklch(88% .06 140)', accent: 'oklch(82% .14 85)', paper: 'oklch(96% .022 120)' },
    { dark: 'oklch(30% .08 32)', mid: 'oklch(62% .17 42)', light: 'oklch(88% .07 70)', accent: 'oklch(66% .14 255)', paper: 'oklch(96% .028 75)' },
    { dark: 'oklch(26% .03 265)', mid: 'oklch(50% .05 262)', light: 'oklch(88% .02 260)', accent: 'oklch(70% .18 25)', paper: 'oklch(96% .01 260)' },
    { dark: 'oklch(32% .07 200)', mid: 'oklch(62% .12 188)', light: 'oklch(90% .05 172)', accent: 'oklch(72% .17 345)', paper: 'oklch(96% .02 190)' }
  ];
  const SVG_OPEN = '<svg viewBox="0 0 320 170" aria-hidden="true" focusable="false"';
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let uid = 0;

  function hash(text) {
    let h = 2166136261 >>> 0;
    for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // A seeded random sequence: the same link always draws the same cover.
  function seeded(text) {
    let h = hash(text);
    return () => {
      h = (h + 0x6D2B79F5) | 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const siteOf = parsed => parsed.hostname.toLowerCase().replace(/^(www|m)\./, '') || 'link';

  // Editorial's two words: an acronym ("GPT") first, then the longest words,
  // skipping filler. A title that is itself a URL falls back to the site.
  const STOP = new Set('a an the of and or to in on for with my your our is are be we how why what when not it its this that from by at as into about pretty much everything going need lets let one out new all can will just more most very still notes'.split(' '));
  function keyWords(title, site) {
    const text = /^https?:\/\//i.test(title) ? site.split('.')[0] : title.split('|')[0];
    const words = text.replace(/[()[\]{}'’".,:;!?—–\-/\\#]/g, ' ').split(/\s+/)
      .filter(w => w.length > 1 && !STOP.has(w.toLowerCase())).map(w => w.slice(0, 16));
    if (!words.length) return [site.split('.')[0].slice(0, 16), ''];
    const score = w => (/^[A-Z0-9]{2,5}$/.test(w) ? 100 : 0) + w.length;
    const top = [...words].sort((a, b) => score(b) - score(a)).slice(0, 2);
    const ordered = words.filter(w => top.includes(w)).slice(0, 2);
    return ordered.length === 2 ? ordered : [ordered[0], ''];
  }

  function editorial(card, site, r, P) {
    const [first, second] = keyWords(String(card.title || ''), site);
    const paper = r() < .65, background = paper ? P.paper : P.dark, ink = paper ? P.dark : P.paper;
    const word = text => `<b style="--len:${Math.max(text.length, 4)}">${esc(text)}</b>`;
    return {
      light: paper, ink,
      art: `<span class="cc-fill" style="background:${background};color:${ink};--cc-ink:${ink}"><i class="cc-ed-dot" style="background:${P.accent};left:${(52 + r() * 30).toFixed(0)}%;top:${(-30 + r() * 45).toFixed(0)}%"></i><span class="cc-ed-kicker">From ${esc(site)}</span><span class="cc-ed-words">${word(first)}${second ? word(second) : ''}</span></span>`
    };
  }

  function signal(card, r, P) {
    const id = `cc${uid++}`, ph = r() * 6, ph2 = r() * 6;
    let bars = '';
    for (let i = 0; i < 64; i++) {
      const v = Math.min(1, Math.max(.08, .42 + .26 * Math.sin(i * .33 + ph) + .18 * Math.sin(i * .91 + ph2) + .22 * (r() - .5)));
      const h = v * 92;
      bars += `<rect class="cc-bar" style="--n:${i}" x="${(17 + i * 4.5).toFixed(1)}" y="${(85 - h / 2).toFixed(1)}" width="2.8" height="${h.toFixed(1)}" rx="1.4"/>`;
    }
    let holes = '';
    for (let x = 6; x < 320; x += 16) holes += `<rect x="${x}" y="5" width="8" height="5" rx="1.5"/><rect x="${x}" y="160" width="8" height="5" rx="1.5"/>`;
    return {
      art: `<span class="cc-fill" style="--cc-accent:${P.accent}">${SVG_OPEN} preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${P.dark}"/><stop offset="1" stop-color="${P.mid}"/></linearGradient></defs><rect width="320" height="170" fill="url(#${id})"/><g fill="#fff" opacity=".16">${holes}</g><g fill="${P.light}" opacity=".9">${bars}</g></svg><i class="cc-played"></i><i class="cc-head"></i></span>`
    };
  }

  function postcard(card, site, r, P) {
    const id = `cc${uid++}`, ink = P.dark;
    const saved = card.created_at ? new Date(card.created_at) : null;
    const valid = saved && !Number.isNaN(saved.getTime());
    const day = valid ? saved.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }).toUpperCase() : 'SAVED';
    const year = valid ? String(saved.getFullYear()) : '';
    // The stamp's perforated edge: paper-coloured dots bitten out of white.
    const sx = 20, sy = 22, sw = 96, sh = 124;
    let bites = '';
    for (let x = sx; x <= sx + sw + .1; x += 9.6) bites += `<circle cx="${x.toFixed(1)}" cy="${sy}" r="3.4"/><circle cx="${x.toFixed(1)}" cy="${sy + sh}" r="3.4"/>`;
    for (let y = sy; y <= sy + sh + .1; y += 9.92) bites += `<circle cx="${sx}" cy="${y.toFixed(1)}" r="3.4"/><circle cx="${sx + sw}" cy="${y.toFixed(1)}" r="3.4"/>`;
    let waves = '';
    for (let k = 0; k < 5; k++) {
      let d = '';
      for (let x = 112; x <= 304; x += 8) d += `${x === 112 ? 'M' : 'L'}${x} ${(46 + k * 8 + 2.6 * Math.sin(x * .09 + k)).toFixed(1)} `;
      waves += `<path d="${d}"/>`;
    }
    // The title on the address lines, wrapped at word boundaries.
    const lines = ['', ''];
    let line = 0;
    for (const word of String(card.title || '').split(/\s+/).filter(Boolean)) {
      if (line === 0 && lines[0] && lines[0].length + word.length > 22) line = 1;
      if (line === 1 && lines[1].length + word.length > 21) { lines[1] = `${lines[1].trimEnd()}…`; break; }
      lines[line] += `${word.slice(0, 22)} `;
    }
    const mark = `${site.toUpperCase().slice(0, 26)} / SAVED /`;
    const ring = 'M115.5 70a34.5 34.5 0 1 1 69 0a34.5 34.5 0 1 1 -69 0';
    return {
      light: true, ink, paper: P.paper,
      art: `<span class="cc-fill" style="background:${P.paper}">${SVG_OPEN} preserveAspectRatio="xMidYMid meet"><defs><linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${P.mid}"/><stop offset="1" stop-color="${P.dark}"/></linearGradient><path id="${id}r" d="${ring}"/></defs>`
        + `<g transform="rotate(-3 68 84)"><g class="cc-stamp"><rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" fill="#fff"/><g fill="${P.paper}">${bites}</g><rect x="${sx + 8}" y="${sy + 8}" width="${sw - 16}" height="${sh - 16}" fill="url(#${id}g)"/><circle cx="${sx + sw - 22}" cy="${sy + 30}" r="16" fill="${P.accent}" opacity=".85"/><text x="${sx + sw / 2}" y="${sy + 86}" text-anchor="middle" font-family="Space Grotesk, sans-serif" font-weight="700" font-size="52" fill="#fff">${esc(site[0].toUpperCase())}</text><text x="${sx + sw / 2}" y="${sy + sh - 15}" text-anchor="middle" font-family="Manrope, sans-serif" font-weight="800" font-size="7" letter-spacing="2" fill="#fff" opacity=".85">CARDLE</text></g></g>`
        + `<g class="cc-waves" fill="none" stroke="${ink}" stroke-width="1.6" opacity=".45">${waves}</g>`
        + `<g class="cc-mark" fill="none" stroke="${ink}" opacity=".78"><circle cx="150" cy="70" r="40" stroke-width="2"/><circle cx="150" cy="70" r="29" stroke-width="1"/><text fill="${ink}" stroke="none" font-family="Manrope, sans-serif" font-weight="800" font-size="7.2"><textPath href="#${id}r" textLength="212" lengthAdjust="spacing">${esc(mark)}</textPath></text><text x="150" y="${year ? 70 : 74}" text-anchor="middle" fill="${ink}" stroke="none" font-family="Space Grotesk, sans-serif" font-weight="700" font-size="12">${esc(day)}</text>${year ? `<text x="150" y="81" text-anchor="middle" fill="${ink}" stroke="none" font-family="Manrope, sans-serif" font-weight="700" font-size="7">${year}</text>` : ''}</g>`
        + `<g stroke="${ink}" stroke-width="1" opacity=".22"><path d="M196 122H300M196 138H300"/></g>`
        + `<text x="198" y="118" font-family="Georgia, serif" font-style="italic" font-size="8.6" fill="${ink}" opacity=".8">${esc(lines[0].trim())}</text><text x="198" y="134" font-family="Georgia, serif" font-style="italic" font-size="8.6" fill="${ink}" opacity=".8">${esc(lines[1].trim())}</text></svg></span>`
    };
  }

  // A faint pattern for each type, behind cards that have no link (and so no
  // cover): ripples for reminders, a grid for work, a commit graph for GitHub
  // issues, circles for family, tiles for everything else.
  function patternHtml(type) {
    const open = '<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">';
    let art;
    if (type === 'reminder') art = `<g fill="none" stroke="currentColor" stroke-width="3">${[0, 1, 2].map(n => `<circle class="cs-ripple" style="--n:${n}" cx="60" cy="60" r="56"/>`).join('')}</g><circle cx="60" cy="60" r="9" fill="currentColor"/>`;
    else if (type === 'work') art = Array.from({ length: 16 }, (_, n) => `<rect class="cs-cell" style="--n:${n}" x="${(n % 4) * 28 + 4}" y="${Math.floor(n / 4) * 28 + 4}" width="22" height="22" rx="5" fill="currentColor"/>`).join('');
    else if (type === 'kanban') art = `<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M30 112V8"/><path d="M30 86c0-26 50-20 50-46V20"/></g>${[[30, 100], [30, 62], [80, 40], [80, 20], [30, 24]].map(([x, y], n) => `<circle class="cs-commit" style="--n:${n}" cx="${x}" cy="${y}" r="8" fill="currentColor"/>`).join('')}`;
    else if (type === 'family') art = '<g class="cs-spin" fill="none" stroke="currentColor" stroke-width="4"><circle cx="60" cy="38" r="28"/><circle cx="40" cy="74" r="28"/><circle cx="80" cy="74" r="28"/></g>';
    else art = '<g class="cs-spin" fill="currentColor"><rect x="8" y="8" width="46" height="46" rx="10"/><rect x="66" y="8" width="46" height="46" rx="10" opacity=".55"/><rect x="8" y="66" width="46" height="46" rx="10" opacity=".55"/><rect x="66" y="66" width="46" height="46" rx="10"/></g>';
    return `<span class="cs-pattern cs-pattern-${esc(type)}" aria-hidden="true"><span>${open}${art}</svg></span></span>`;
  }

  // kind: 'video' | 'article' | 'bookmark'. `parsed` is the link's URL, already
  // checked by the feed (http(s) only, no credentials). `label` overrides the
  // site name, e.g. for an uploaded video.
  function coverHtml(card, parsed, kind, label) {
    const site = siteOf(parsed);
    const P = PALETTES[hash(site) % PALETTES.length];
    const r = seeded(`${kind}:${parsed.href}`);
    const out = kind === 'video' ? signal(card, r, P) : kind === 'bookmark' ? postcard(card, site, r, P) : editorial(card, site, r, P);
    const title = esc(card.title || label || site);
    const action = kind === 'video' ? 'Watch' : kind === 'bookmark' ? 'Open' : 'Read';
    // The postcard carries its site and title in the art, so it needs no label.
    const meta = kind === 'bookmark' ? '' : `<span class="cc-meta"><b aria-hidden="true">${esc((label || site)[0].toUpperCase())}</b><span>${esc(label || site)}</span><em>${action}</em></span>`;
    const scrim = meta && !out.light ? '<i class="cc-scrim" aria-hidden="true"></i>' : '';
    const style = [out.ink ? `--cc-ink:${out.ink}` : '', out.paper ? `background:${out.paper}` : ''].filter(Boolean).join(';');
    return `<a class="aurora-card-media aurora-media-preview cardle-cover cc-${kind}${out.light ? ' cc-light' : ''}" href="${esc(parsed.href)}" target="_blank" rel="noopener noreferrer" data-interactive data-cc-key="${esc(`${card.type}:${card.id}`)}"${style ? ` style="${style}"` : ''} aria-label="${action} ${title} (opens in a new tab)">${out.art}${scrim}${meta}</a>`;
  }

  // Covers and feed cards (anything with data-cc-key) animate once when they
  // first come on screen, and loop (playhead, patterns, the due-today pulse)
  // only while on screen. The feed re-renders its cards on every like or pin,
  // so something already seen is marked straight away instead of replaying
  // its entrance.
  const seen = new Set();
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const { target, isIntersecting } of entries) {
      if (isIntersecting) { target.classList.add('cc-in-view', 'cc-visible'); seen.add(target.dataset.ccKey); }
      else target.classList.remove('cc-visible');
    }
  }, { threshold: .3 }) : null;
  function watch(node) {
    const watched = node.matches?.('[data-cc-key]') ? [node, ...node.querySelectorAll('[data-cc-key]')] : node.querySelectorAll?.('[data-cc-key]') || [];
    for (const cover of watched) {
      if (seen.has(cover.dataset.ccKey)) cover.classList.add('cc-seen');
      if (io) io.observe(cover); else cover.classList.add('cc-seen');
    }
  }
  function unwatch(node) {
    if (!io) return;
    const watched = node.matches?.('[data-cc-key]') ? [node, ...node.querySelectorAll('[data-cc-key]')] : node.querySelectorAll?.('[data-cc-key]') || [];
    for (const cover of watched) io.unobserve(cover);
  }
  if (typeof MutationObserver === 'function') {
    new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) if (node.nodeType === 1) unwatch(node);
        for (const node of mutation.addedNodes) if (node.nodeType === 1) watch(node);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // Covers are laid out in container query units (cqw, cqh) and coloured in
  // oklch(). Older browsers -- iPadOS 15 and earlier, Chrome included, since
  // it runs on Safari's engine there -- drop both, piling the labels into one
  // corner of an empty box. They get the feed's plain cover instead.
  const drawable = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    && CSS.supports('width', '1cqw') && CSS.supports('color', 'oklch(50% .1 260)');

  window.CardleCovers = { coverHtml: drawable ? coverHtml : null, patternHtml, keyWords };
})();
