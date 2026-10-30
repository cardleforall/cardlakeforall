// "Add to Google Calendar" on a reminder: a link to Google Calendar's own
// new-event page with the reminder filled in, so Google sends the alert
// Cardlake doesn't (docs/functional.md, "Out of scope"). It's a copy, not a
// sync: Cardlake never calls Google, holds no Google token, and nothing is
// saved in the calendar until the person saves it there.
//
//   due 2026-10-20 (no time)     -> an all-day event on 20 October
//   due 2026-10-20T09:00:00Z     -> 09:00-09:30 UTC, shown in their time zone
//   repeats weekly               -> RRULE:FREQ=WEEKLY
//
// A monthly reminder on the 29th-31st skips months too short for that day in
// Google, where Cardlake moves it to the month's last day instead.
(function (root) {
  'use strict';
  const TEMPLATE_URL = 'https://calendar.google.com/calendar/render';
  const RRULE_FREQ = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };
  // Cardlake has no end time. A short block keeps a timed reminder from
  // reading as an all-day event in the calendar.
  const TIMED_MINUTES = 30;
  // Feed-created due dates are a day with no time, stored as UTC midnight
  // (the same test the feed's subtitle uses).
  const DAY_ONLY = /T00:00:00(\.000)?Z$/;

  const pad2 = n => String(n).padStart(2, '0');
  const utcDay = d => `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
  const utcStamp = d => `${utcDay(d)}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
  const localDay = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  // The `dates` value: an all-day event's end day is exclusive.
  function eventDates(dueDate) {
    const due = new Date(dueDate);
    if (DAY_ONLY.test(dueDate)) return `${utcDay(due)}/${utcDay(new Date(due.getTime() + 864e5))}`;
    return `${utcStamp(due)}/${utcStamp(new Date(due.getTime() + TIMED_MINUTES * 60e3))}`;
  }

  // Past due and never coming back: there's nothing left to be alerted to.
  // A repeating reminder still has occurrences ahead, so it keeps the link.
  function isPast(dueDate, now) {
    if (DAY_ONLY.test(dueDate)) return dueDate.slice(0, 10) < localDay(now);
    return new Date(dueDate).getTime() < now.getTime();
  }

  // The link for a feed card, or null when it shouldn't offer one: not a
  // reminder, no (valid) due date, already completed, or a one-off already past.
  // `cardleUrl` goes in the event's description so it leads back to Cardlake.
  function googleCalendarUrl(card, { now = new Date(), cardleUrl = '' } = {}) {
    const m = card?.metadata || {};
    if (card?.type !== 'reminder' || m.completed || typeof m.due_date !== 'string') return null;
    if (Number.isNaN(new Date(m.due_date).getTime())) return null;
    const freq = RRULE_FREQ[m.recurrence];
    if (!freq && isPast(m.due_date, now)) return null;
    const params = new URLSearchParams({ action: 'TEMPLATE', text: card.title || 'Reminder', dates: eventDates(m.due_date) });
    if (freq) params.set('recur', `RRULE:FREQ=${freq}`);
    if (cardleUrl) params.set('details', `From Cardlake: ${cardleUrl}`);
    return `${TEMPLATE_URL}?${params}`;
  }

  const api = { googleCalendarUrl };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.CardleCalendar = api;
}(typeof window !== 'undefined' ? window : globalThis));
