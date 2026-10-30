// public/vault/assets/share-target.js: what a link shared from another app
// (Android's share sheet) turns into, and how it waits through sign-in.
// Run by test_share_target.py.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseShare, shareDraft } = require('../../public/vault/assets/share-target.js');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../public/vault/assets/share-target.js'), 'utf8');

// Loads the script as the vault page does, against a fake address and tab storage.
function openPage(href, storage = new Map()) {
  const url = new URL(href, 'https://cardlake.example');
  const replaced = [];
  const window = {
    location: { pathname: url.pathname, search: url.search, hash: url.hash },
    history: { state: null, replaceState: (state, title, next) => replaced.push(next) },
    sessionStorage: { getItem: key => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
  };
  window.window = window;
  window.URLSearchParams = URLSearchParams;
  vm.runInNewContext(SCRIPT, window);
  return { share: window.CardleShare, replaced, storage };
}

const tests = {
  whatsapp_puts_the_link_in_the_text() {
    const draft = shareDraft(parseShare('?text=' + encodeURIComponent('Worth a read https://example.com/post?id=7.')));
    assert.equal(draft.type, 'bookmark');
    assert.equal(draft.values.url, 'https://example.com/post?id=7');
    assert.equal(draft.values.title, 'Worth a read');
    assert.equal(draft.values.notes, '');
  },
  a_browser_share_sends_title_and_url() {
    const draft = shareDraft(parseShare('?title=Example%20Post&url=https%3A%2F%2Fexample.com%2Fa'));
    assert.deepEqual(draft, { type: 'bookmark', values: { title: 'Example Post', url: 'https://example.com/a', notes: '', content: 'Example Post' } });
  },
  a_bare_link_is_its_own_title() {
    const draft = shareDraft(parseShare('?text=https%3A%2F%2Fyoutu.be%2Fabc'));
    assert.equal(draft.values.title, 'https://youtu.be/abc');
    assert.equal(draft.values.url, 'https://youtu.be/abc');
  },
  text_without_a_link_becomes_a_misc_card() {
    const text = 'Call the plumber\nabout the kitchen tap';
    const draft = shareDraft(parseShare('?text=' + encodeURIComponent(text)));
    assert.equal(draft.type, 'talking_point');
    assert.equal(draft.values.title, 'Call the plumber');
    assert.equal(draft.values.content, text);
    assert.equal(draft.values.url, '');
  },
  only_web_links_are_taken_as_the_url() {
    const draft = shareDraft(parseShare('?title=x&url=' + encodeURIComponent('javascript:alert(1)')));
    assert.equal(draft.values.url, '');
    assert.equal(draft.type, 'talking_point');
  },
  long_shares_are_cut_to_the_card_limits() {
    const draft = shareDraft(parseShare('?text=' + 'a'.repeat(500)), { titleMax: 200, contentMax: 300 });
    assert.equal(draft.values.title.length, 200);
    assert.equal(draft.values.notes.length, 300);
  },
  an_ordinary_visit_is_not_a_share() {
    assert.equal(parseShare(''), null);
    assert.equal(parseShare('?welcome=1'), null);
    assert.equal(parseShare('?title=&text=&url='), null);
  },
  the_share_leaves_the_address_and_waits_in_the_tab() {
    const page = openPage('/vault/index.html?signin=1&text=hi%20https%3A%2F%2Fexample.com#about');
    assert.deepEqual(page.replaced, ['/vault/index.html?signin=1#about']);
    assert.equal(page.share.pending().text, 'hi https://example.com');
    // Signed out, the app goes to welcome.html and back with no query.
    const back = openPage('/vault/index.html', page.storage);
    assert.deepEqual(back.replaced, []);
    assert.equal(back.share.pending().text, 'hi https://example.com');
    back.share.clear();
    assert.equal(openPage('/vault/index.html', page.storage).share.pending(), null);
  },
};

(async () => {
  for (const [name, test] of Object.entries(tests)) {
    try { await test(); console.log(`ok - ${name}`); }
    catch (error) { console.error(`not ok - ${name}\n${error.stack}`); process.exitCode = 1; }
  }
})();
