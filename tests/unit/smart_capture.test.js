// public/vault/assets/smart-capture.js: what quick add guesses from the text
// typed at the top of the new-card dialog. Run by test_smart_capture.py.
'use strict';
const assert = require('assert/strict');
const { draftFromText, QUICK_KEYS } = require('../../public/vault/assets/smart-capture.js');

// Monday 12 October 2026.
const today = new Date(2026, 9, 12);
const guess = (text, limits = {}) => draftFromText(text, { today, ...limits });

const tests = {
  a_repeating_reminder_starts_on_the_next_such_day() {
    const draft = guess('Call mum every Sunday');
    assert.equal(draft.type, 'reminder');
    assert.equal(draft.values.title, 'Call mum');
    assert.equal(draft.values.due_date, '2026-10-18');
    assert.equal(draft.values.recurrence, 'weekly');
  },
  a_repeat_said_on_its_own_day_starts_today() {
    assert.equal(guess('Team sync every Monday').values.due_date, '2026-10-12');
  },
  a_date_and_the_word_joining_it_leave_the_title() {
    const draft = guess('Dentist on 3 Nov');
    assert.deepEqual([draft.type, draft.values.title, draft.values.due_date, draft.values.recurrence], ['reminder', 'Dentist', '2026-11-03', '']);
  },
  dates_people_write() {
    const due = text => guess(text).values.due_date;
    assert.equal(due('Buy milk tomorrow'), '2026-10-13');
    assert.equal(due('Renew passport by 2027-01-15'), '2027-01-15');
    assert.equal(due('Christmas shopping Dec 20'), '2026-12-20');
    assert.equal(due('Call Sam in 2 weeks'), '2026-10-26');
    assert.equal(due('Pay the bill on the 31st'), '2026-10-31');
    assert.equal(due('Plan the party on Friday'), '2026-10-16');
    assert.equal(due('Call dad on sat'), '2026-10-17');
  },
  a_day_and_month_already_past_is_next_year() {
    assert.equal(guess('Book holiday 5 March').values.due_date, '2027-03-05');
  },
  a_repeat_with_its_own_date() {
    const draft = guess('Pay rent on the 1st every month');
    assert.deepEqual([draft.values.title, draft.values.due_date, draft.values.recurrence], ['Pay rent', '2026-11-01', 'monthly']);
    assert.deepEqual([guess('Birthday 3 March every year').values.due_date, guess('Gym every day').values.recurrence], ['2027-03-03', 'daily']);
  },
  ordinary_words_are_not_read_as_days() {
    for (const text of ['Lie in the sun', 'I sat down with Mar', 'Anniversary 31 April']) {
      assert.equal(guess(text).values.due_date, '', text);
    }
  },
  remind_me_is_taken_off_the_title() {
    const draft = guess('remind me to water the plants');
    assert.deepEqual([draft.type, draft.values.title, draft.values.due_date], ['reminder', 'Water the plants', '']);
  },
  plain_text_is_a_reminder_with_no_date() {
    const draft = guess('Buy new running shoes');
    assert.deepEqual([draft.type, draft.values.title, draft.values.due_date], ['reminder', 'Buy new running shoes', '']);
  },
  something_to_read_or_watch_is_a_learning() {
    assert.equal(guess('Read Atomic Habits').type, 'learning');
    const video = guess('https://youtu.be/abc');
    assert.deepEqual([video.type, video.values.url], ['learning', 'https://youtu.be/abc']);
  },
  other_links_are_bookmarks() {
    const draft = guess('Worth a read https://example.com/post.');
    assert.deepEqual([draft.type, draft.values.title, draft.values.url], ['bookmark', 'Worth a read', 'https://example.com/post']);
  },
  short_lines_are_a_work_checklist() {
    const draft = guess('Pack for the trip:\n- passport\n* charger\n1. [ ] socks');
    assert.equal(draft.type, 'work');
    assert.equal(draft.values.title, 'Pack for the trip');
    assert.equal(draft.values.items_text, 'passport\ncharger\nsocks');
  },
  a_paragraph_is_a_misc_note() {
    const text = `Idea for the garden\n${'We could move the bench under the tree and plant lavender along the path. '.repeat(2)}`;
    const draft = guess(text);
    assert.equal(draft.type, 'talking_point');
    assert.equal(draft.values.title, 'Idea for the garden');
    assert.equal(draft.values.content, text.trim());
  },
  // Every key is set, so editing the text clears what an earlier guess filled.
  every_draft_sets_every_quick_field() {
    for (const text of ['Call mum every Sunday', 'https://example.com', 'a\nb', 'hello']) {
      assert.deepEqual(Object.keys(guess(text).values).sort(), [...QUICK_KEYS].sort(), text);
    }
    assert.equal(guess('Call mum').values.recurrence, '');
  },
  empty_text_guesses_nothing() {
    assert.equal(guess('   '), null);
  },
  long_text_is_cut_to_the_card_limits() {
    const draft = guess('a'.repeat(500), { titleMax: 200, contentMax: 300 });
    assert.equal(draft.values.title.length, 200);
    assert.equal(draft.values.content.length, 300);
  },
};

let failed = 0;
for (const [name, test] of Object.entries(tests)) {
  try { test(); } catch (error) { failed += 1; console.error(`FAIL ${name}\n${error.message}`); }
}
if (failed) process.exit(1);
console.log(`${Object.keys(tests).length} smart-capture tests passed`);
