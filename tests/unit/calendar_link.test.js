// public/vault/assets/calendar-link.js: the "Add to Google Calendar" link
// on a reminder. Run by test_calendar_link.py.
'use strict';
const assert = require('assert/strict');
const { googleCalendarUrl } = require('../../public/vault/assets/calendar-link.js');

// Tuesday 13 October 2026, midday UTC.
const now = new Date(Date.UTC(2026, 9, 13, 12));
const reminder = (metadata, extra = {}) => ({ type: 'reminder', id: 'r1', title: 'Renew passport', metadata: { completed: false, recurrence: null, ...metadata }, ...extra });
const link = (card, options = {}) => googleCalendarUrl(card, { now, ...options });
const params = url => new URL(url).searchParams;

const tests = {
  a_day_only_reminder_is_an_all_day_event() {
    const url = link(reminder({ due_date: '2026-10-20T00:00:00.000Z' }));
    assert.ok(url.startsWith('https://calendar.google.com/calendar/render?'));
    const p = params(url);
    assert.equal(p.get('action'), 'TEMPLATE');
    assert.equal(p.get('text'), 'Renew passport');
    // The end day is exclusive.
    assert.equal(p.get('dates'), '20261020/20261021');
    assert.equal(p.get('recur'), null);
  },
  the_last_day_of_a_month_ends_on_the_next_month() {
    assert.equal(params(link(reminder({ due_date: '2026-12-31T00:00:00Z' }))).get('dates'), '20261231/20270101');
  },
  a_timed_reminder_is_a_half_hour_event_in_utc() {
    const p = params(link(reminder({ due_date: '2026-10-20T09:15:00.000Z' })));
    assert.equal(p.get('dates'), '20261020T091500Z/20261020T094500Z');
  },
  a_repeating_reminder_carries_its_repeat() {
    const recur = recurrence => params(link(reminder({ due_date: '2026-10-20T00:00:00Z', recurrence }))).get('recur');
    assert.equal(recur('daily'), 'RRULE:FREQ=DAILY');
    assert.equal(recur('weekly'), 'RRULE:FREQ=WEEKLY');
    assert.equal(recur('monthly'), 'RRULE:FREQ=MONTHLY');
    assert.equal(recur('yearly'), 'RRULE:FREQ=YEARLY');
  },
  the_description_links_back_to_cardle() {
    const p = params(link(reminder({ due_date: '2026-10-20T00:00:00Z' }), { cardleUrl: 'https://cardlake.example/vault/' }));
    assert.equal(p.get('details'), 'From Cardlake: https://cardlake.example/vault/');
    assert.equal(params(link(reminder({ due_date: '2026-10-20T00:00:00Z' }))).get('details'), null);
  },
  titles_are_encoded_not_injected() {
    const url = link(reminder({ due_date: '2026-10-20T00:00:00Z' }, { title: 'Pay rent & bills #2 "now"?' }));
    assert.equal(params(url).get('text'), 'Pay rent & bills #2 "now"?');
    assert.ok(!url.includes('"'));
  },
  due_today_still_offers_the_link() {
    assert.ok(link(reminder({ due_date: '2026-10-13T00:00:00Z' })));
    assert.ok(link(reminder({ due_date: '2026-10-13T18:00:00Z' })));
  },
  a_one_off_already_past_offers_nothing() {
    assert.equal(link(reminder({ due_date: '2026-10-12T00:00:00Z' })), null);
    assert.equal(link(reminder({ due_date: '2026-10-13T08:00:00Z' })), null);
  },
  a_repeating_reminder_past_due_still_has_occurrences_ahead() {
    assert.ok(link(reminder({ due_date: '2026-10-01T00:00:00Z', recurrence: 'weekly' })));
  },
  only_reminders_with_a_usable_due_date() {
    assert.equal(link(reminder({ due_date: null })), null);
    assert.equal(link(reminder({})), null);
    assert.equal(link(reminder({ due_date: 'not a date' })), null);
    assert.equal(link(reminder({ due_date: '2026-10-20T00:00:00Z', completed: true })), null);
    assert.equal(link({ type: 'work', title: 'Q3', metadata: { due_date: '2026-10-20T00:00:00Z' } }), null);
    assert.equal(link({ type: 'reminder', title: 'No metadata' }), null);
    assert.equal(link(null), null);
  },
  an_untitled_reminder_still_gets_a_title() {
    assert.equal(params(link(reminder({ due_date: '2026-10-20T00:00:00Z' }, { title: '' }))).get('text'), 'Reminder');
  },
};

let failed = 0;
for (const [name, test] of Object.entries(tests)) {
  try { test(); } catch (error) { failed += 1; console.error(`FAIL ${name}\n${error.stack}`); }
}
if (failed) process.exit(1);
console.log(`${Object.keys(tests).length} calendar link tests passed`);
