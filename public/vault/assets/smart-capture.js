// Quick add: whatever someone types at the top of the new-card dialog,
// guessed into a card type and its fields. It runs on fixed rules in the
// browser -- nothing typed goes to a model or a provider (docs/AI_DATA_USE.md)
// -- and the dialog shows the guess in its fields before anything is saved,
// so a wrong guess is corrected by picking another type.
//
//   "Call mum every Sunday"         -> Reminder, weekly, from the next Sunday
//   "Dentist on 3 Nov"              -> Reminder due 3 November
//   "https://youtu.be/abc"          -> Learn, with the link
//   "Pack for trip\npassport\nkeys" -> Work, with a two-item checklist
(function (root) {
  'use strict';
  const share = root.CardleShare || (typeof require === 'function' ? require('./share-target.js') : null);

  // Every field quick add fills. Each draft sets all of them, so editing the
  // text clears what an earlier guess filled (a removed "every Sunday" clears
  // the repeat). A Misc card's title field shares the `title` key.
  const QUICK_KEYS = ['title', 'url', 'notes', 'content', 'due_date', 'recurrence', 'items_text'];

  const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const WEEKDAY = '(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)';
  // A bare abbreviation is too often an ordinary word ("in the sun", "I sat"),
  // so a one-off date names the day in full or follows on/next/this/by.
  const FULL_WEEKDAY = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const ORDINAL = '(?:st|nd|rd|th)?';
  const COUNTS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  // Hosts whose links are something to watch or study rather than keep.
  const LEARNING_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|ted\.com|coursera\.org|udemy\.com|edx\.org|khanacademy\.org)$/i;
  const LEARNING_VERB = /^(read|watch|learn|study|listen to|finish reading)\b/i;
  const REMIND_ME = /^(please\s+)?remind me\s+(to|about|that)?\s*/i;
  // A word that only joined the date to the rest ("dentist on Friday").
  const CONNECTIVE = /\s+(on|by|at|for|due|this|before|from|starting|until)\s*$/i;

  const weekdayIndex = word => WEEKDAYS.indexOf(word.slice(0, 3).toLowerCase());
  const monthIndex = word => MONTHS.indexOf(word.slice(0, 3).toLowerCase());
  const pad = n => String(n).padStart(2, '0');
  const isoDate = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const addDays = (today, days) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  function addMonths(today, months) {
    const first = new Date(today.getFullYear(), today.getMonth() + months, 1);
    const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return new Date(first.getFullYear(), first.getMonth(), Math.min(today.getDate(), lastDay));
  }
  // The next such weekday: from today when it repeats ("every Sunday" said on
  // a Sunday starts today), otherwise strictly after today.
  function nextWeekday(today, index, includeToday) {
    const ahead = (index - today.getDay() + 7) % 7;
    return addDays(today, ahead === 0 && !includeToday ? 7 : ahead);
  }
  // A day and month without a year is the next one to come.
  function dayOfMonth(today, day, month, year) {
    const date = new Date(year || today.getFullYear(), month, day);
    if (date.getMonth() !== month) return null; // 31 April
    if (!year && date < addDays(today, 0)) date.setFullYear(date.getFullYear() + 1);
    return date;
  }

  // Recurrence: [pattern, repeat, first due date from the match].
  const REPEATS = [
    [new RegExp(`\\b(?:every|each)\\s+${WEEKDAY}s?\\b`, 'i'), 'weekly', (m, today) => nextWeekday(today, weekdayIndex(m[1]), true)],
    [new RegExp(`\\bon\\s+${WEEKDAY}s\\b`, 'i'), 'weekly', (m, today) => nextWeekday(today, weekdayIndex(m[1]), true)],
    [/\b(?:every|each)\s*(?:day|morning|evening|night)\b|\bdaily\b/i, 'daily', (m, today) => today],
    [/\b(?:every|each)\s+week\b|\bweekly\b/i, 'weekly', (m, today) => today],
    [/\b(?:every|each)\s+month\b|\bmonthly\b/i, 'monthly', (m, today) => today],
    [/\b(?:every|each)\s+year\b|\byearly\b|\bannually\b/i, 'yearly', (m, today) => today],
  ];
  // One-off dates, most specific first.
  const DATES = [
    [/\b(\d{4})-(\d{2})-(\d{2})\b/, (m, today) => dayOfMonth(today, Number(m[3]), Number(m[2]) - 1, Number(m[1]))],
    [new RegExp(`\\b(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?${MONTH}\\b(?:,?\\s+(\\d{4}))?`, 'i'), (m, today) => dayOfMonth(today, Number(m[1]), monthIndex(m[2]), Number(m[3]) || 0)],
    [new RegExp(`\\b${MONTH}\\s+(\\d{1,2})${ORDINAL}\\b(?:,?\\s+(\\d{4}))?`, 'i'), (m, today) => dayOfMonth(today, Number(m[2]), monthIndex(m[1]), Number(m[3]) || 0)],
    // "the 1st" is the next 1st of a month ("pay rent on the 1st every month").
    [/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/i, (m, today) => {
      const day = Number(m[1]);
      for (let months = 0; months < 12; months += 1) {
        const date = dayOfMonth(today, day, (today.getMonth() + months) % 12, today.getFullYear() + Math.floor((today.getMonth() + months) / 12));
        if (date && date >= today) return date;
      }
      return null;
    }],
    [/\bday after tomorrow\b/i, (m, today) => addDays(today, 2)],
    [/\b(?:today|tonight|this (?:morning|afternoon|evening))\b/i, (m, today) => today],
    [/\b(?:tomorrow|tmrw)\b/i, (m, today) => addDays(today, 1)],
    [/\bin\s+(\d+|an?|one|two|three|four|five|six)\s+(day|week|month|year)s?\b/i, (m, today) => {
      const n = Number(m[1]) || COUNTS[m[1].toLowerCase()];
      const unit = m[2].toLowerCase();
      if (unit === 'day') return addDays(today, n);
      if (unit === 'week') return addDays(today, 7 * n);
      return addMonths(today, unit === 'month' ? n : 12 * n);
    }],
    [/\bnext\s+(week|month|year)\b/i, (m, today) => {
      const unit = m[1].toLowerCase();
      return unit === 'week' ? addDays(today, 7) : addMonths(today, unit === 'month' ? 1 : 12);
    }],
    [new RegExp(`\\b(?:(?:next|this|on|by)\\s+${WEEKDAY}|${FULL_WEEKDAY})\\b`, 'i'), (m, today) => nextWeekday(today, weekdayIndex(m[1] || m[2]), false)],
  ];

  // Takes the first match of one of the rules out of the text.
  function takeFirst(text, rules, today) {
    for (const [pattern, ...rest] of rules) {
      const match = text.match(pattern);
      if (!match) continue;
      const date = rest[rest.length - 1](match, today);
      if (!date) continue;
      const before = text.slice(0, match.index).replace(CONNECTIVE, '');
      return { rest: `${before} ${text.slice(match.index + match[0].length)}`, date, repeat: rest.length > 1 ? rest[0] : '' };
    }
    return null;
  }
  const tidy = text => text.replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '');
  const capitalise = text => text.charAt(0).toUpperCase() + text.slice(1);
  // "- passport", "* keys", "1. charger", "[ ] socks" -> the item itself.
  const listItem = line => line.replace(/^\s*(?:(?:[-*•]|\d+[.)]|\[[ xX]?\])\s*)+/, '').trim();

  function draft(type, values, limits) {
    const out = Object.fromEntries(QUICK_KEYS.map(key => [key, '']));
    Object.assign(out, values);
    out.title = out.title.slice(0, limits.titleMax);
    ['notes', 'content', 'items_text'].forEach(key => { out[key] = out[key].slice(0, limits.contentMax); });
    return { type, values: out };
  }

  function draftFromText(input, { today = new Date(), titleMax = 200, contentMax = 50000 } = {}) {
    const text = String(input || '').trim();
    if (!text) return null;
    const limits = { titleMax, contentMax };
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    const link = share && share.shareDraft({ title: '', text, url: '' });
    if (link && link.values.url) {
      let host = '';
      try { host = new URL(link.values.url).hostname; } catch (_) { /* shareDraft only passes web links */ }
      const learning = LEARNING_HOSTS.test(host) || LEARNING_VERB.test(text);
      return draft(learning ? 'learning' : 'bookmark', { title: link.values.title, url: link.values.url, notes: link.values.notes, content: link.values.content }, limits);
    }

    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length > 1) {
      const title = lines[0].replace(/:$/, '');
      const rest = lines.slice(1);
      // Short lines read as a checklist; a paragraph reads as a note.
      if (rest.every(line => line.length <= 120)) return draft('work', { title, items_text: rest.map(listItem).filter(Boolean).join('\n'), content: text }, limits);
      return draft('talking_point', { title, content: text }, limits);
    }

    const asked = REMIND_ME.test(text);
    let rest = text.replace(REMIND_ME, '');
    const repeat = takeFirst(rest, REPEATS, day);
    if (repeat) rest = repeat.rest;
    const date = takeFirst(rest, DATES, day);
    if (date) rest = date.rest;
    const title = capitalise(tidy(rest)) || text;
    if (repeat || date || asked) {
      return draft('reminder', { title, due_date: date || repeat ? isoDate((date || repeat).date) : '', recurrence: repeat ? repeat.repeat : '', content: text }, limits);
    }
    if (LEARNING_VERB.test(text)) return draft('learning', { title: text, content: text }, limits);
    return draft('reminder', { title: text, content: text }, limits);
  }

  const api = { draftFromText, QUICK_KEYS };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.CardleSmartCapture = api;
}(typeof window !== 'undefined' ? window : globalThis));
