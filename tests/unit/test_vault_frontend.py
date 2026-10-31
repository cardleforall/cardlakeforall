"""Contracts for the signed-in vault app's frontend: the Aurora feed, the
shell page, kanban's frontend, and the sandbox mode used by the marketing
site's live demo. Pure source/text checks against the shipped JS/CSS/HTML --
no browser, no server.

The six tests below "Legacy nav / feed UI polish" originally lived in their
own file (test_vault_ui_contracts.py) that was never wired into
tests/run_tests.sh or CI -- it had been silently skipped since it was
written. They're folded in here rather than left orphaned again."""
from __future__ import annotations

import json
import re
import subprocess
import unittest

from ._paths import AURORA_FEED_JS, ROOT, SANDBOX_HTML, VAULT_INDEX, VAULT_JS, source

AURORA_CSS = ROOT / "public" / "vault" / "assets" / "aurora.css"
AURORA_FEED_CSS = ROOT / "public" / "vault" / "assets" / "aurora-feed.css"


class VaultFrontendTests(unittest.TestCase):
    def test_empty_feed_keeps_its_controls_at_the_top(self):
        css = source(AURORA_FEED_CSS)
        # `margin:auto` on the grid item consumes vertical free space when the
        # feed is empty, which centers the entire view. Keep auto margins on
        # the horizontal axis only.
        self.assertIn(".aurora-main{max-width:760px;width:100%;margin:0 auto;padding:24px 22px}", css)
        self.assertNotIn(".aurora-main{max-width:760px;width:100%;margin:auto;", css)

    def test_feed_sends_viewer_timezone_and_shows_a_real_zero_streak(self):
        js = source(AURORA_FEED_JS)
        # The server counts streak days in the viewer's calendar (see
        # streak_scenarios.js), so every feed request must carry the zone.
        self.assertIn("Intl.DateTimeFormat().resolvedOptions().timeZone", js)
        self.assertIn("p.set('tz', tz)", js)
        # A 0 streak used to be displayed as 1, hiding timezone bugs.
        self.assertNotIn("streak_days || 1", js)
        self.assertIn("el.hidden = streak() < 1", js)

    def test_aurora_frontend_uses_server_stats_real_primary_actions_and_type_aware_capture(self):
        js = source(AURORA_FEED_JS)
        for token in (
            "state.stats.review", "state.stats.streak_days", "reviewed_today", "total_today",
            "/api/reminders/${card.id}", "completed: true", "/api/learnings/${card.id}", "status: 'watched'",
            "card.metadata?.external_url", "window.open", "new FormData()", "data.append('file'",
            "name=\"person\"", "name=\"section_title\"", "name=\"content\"", "metadata?.attachments",
            "if (type === 'learning') { values.status = 'saved'; values.category = 'others'; }",
        ):
            self.assertIn(token, js)

    def test_reminder_capture_offers_a_repeats_select(self):
        js = source(AURORA_FEED_JS)
        fields = js.split("function captureFields(type) {", 1)[1].split("\n  function ", 1)[0]
        self.assertIn('<select name="recurrence">', fields)
        for value, label in (("", "Never"), ("daily", "Daily"), ("weekly", "Weekly"), ("monthly", "Monthly"), ("yearly", "Yearly")):
            self.assertIn(f'<option value="{value}">{label}</option>', fields)
        # Only reminders repeat: the select sits inside the reminder-only branch.
        reminder_branch = fields.split("type === 'reminder' ?", 1)[1].split(" : ''}", 1)[0]
        self.assertIn('name="recurrence"', reminder_branch)

    def test_snooze_length_can_be_chosen_and_changed(self):
        js = source(AURORA_FEED_JS)
        # The API call carries the number of days.
        feed_action = js.split("async function feedAction(card, action, days) {", 1)[1].split("\n  }", 1)[0]
        self.assertIn("...(days ? { days } : {})", feed_action)
        # The front end allows what the server allows.
        server_max = re.search(r"const MAX_SNOOZE_DAYS = (\d+);", source(ROOT / "api" / "feed.js")).group(1)
        self.assertIn(f"const MAX_SNOOZE_DAYS = {server_max};", js)
        # The detail view's Snooze uses the "Snooze for N days" field.
        detail = js.split("function detail(card) {", 1)[1].split("\n  const CAPTURE_SINGULAR_KEY", 1)[0]
        self.assertIn('<label class="aurora-snooze-days">Snooze for ${snoozeDaysInputHtml()} days</label>', detail)
        self.assertIn("leave('remind_later', days);", detail)
        # A snoozed card's return can be changed from the Snoozed view.
        self.assertIn("data-snooze-change", js.split("function actionButtonsHtml(card) {", 1)[1].split("\n  }", 1)[0])
        self.assertIn("changeSnooze(card);", js)
        change = js.split("function changeSnooze(card) {", 1)[1].split("\n  }", 1)[0]
        self.assertIn("feedAction(card, 'remind_later', days)", change)
        self.assertIn("snoozeDaysInputHtml(snoozeDaysLeft(card))", change)

    def test_completing_a_reminder_marks_it_done_instead_of_deleting_it(self):
        js = source(AURORA_FEED_JS)
        self.assertIn("function dismissCard(card) {", js)
        dismiss = js.split("function dismissCard(card) {", 1)[1].split("\n  }", 1)[0]
        # Every reminder, repeating or not, is completed; other cards are deleted.
        self.assertIn("if (card.type !== 'reminder' || SANDBOX) return feedAction(card, 'dismiss');", dismiss)
        self.assertIn("V.api(`/api/reminders/${card.id}`, { method: 'PATCH', keepalive: true, body: JSON.stringify({ completed: true }) })", dismiss)
        self.assertIn("const repeats = card => card.type === 'reminder' && !!card.metadata?.recurrence;", js)
        # The card's Dismiss button, its swipe and the detail view's Dismiss
        # button all go through removeAfterFeedAction, and so all get Undo.
        remove = js.split("function removeAfterFeedAction(card, el, action, days) {", 1)[1].split("\n  }", 1)[0]
        self.assertIn("const run = () => (action === 'dismiss' ? dismissCard(card) : action === 'stop' ? feedAction(card, 'dismiss') : feedAction(card, action, days));", remove)
        self.assertNotIn("feedAction(card, action).catch", remove)
        detail = js.split("function detail(card) {", 1)[1].split("\n  const CAPTURE_SINGULAR_KEY", 1)[0]
        self.assertIn("node.querySelector('[data-detail-dismiss]').onclick = () => leave('dismiss');", detail)
        self.assertIn("removeAfterFeedAction(card, el, action, days);", detail)
        # Cards keep two buttons, but a recurring reminder's Delete reads
        # "Done" on the button, the swipe hint and in the detail view, since
        # it doesn't delete anything.
        buttons = js.split("function actionButtonsHtml(card) {", 1)[1].split("\n  function ", 1)[0]
        self.assertIn("return `<div class=\"aurora-card-actions\">${dismiss}${remind}</div>`;", buttons)
        self.assertIn("const dismissLabel = card => repeats(card) ? 'Done' :", js)
        self.assertIn('aria-label="${dismissLabel(card)}: ${esc(titleOf(card))}"><span aria-hidden="true">←</span> ${dismissLabel(card)}</button>', buttons)
        self.assertIn("${repeats(card) ? 'Done ↙' : isGithubIssue(card) ? 'Remove ↙' : card.type === 'reminder' ? 'Complete ↙' : 'Delete ↙'}", js)
        self.assertIn('data-detail-dismiss class="aurora-quiet aurora-dismiss" aria-label="${dismissLabel(card)}: ${esc(titleOf(card))}"><span aria-hidden="true">←</span> ${dismissLabel(card)}</button>', detail)

    def test_stop_repeating_in_the_detail_view_deletes_a_recurring_reminder(self):
        js = source(AURORA_FEED_JS)
        detail = js.split("function detail(card) {", 1)[1].split("\n  const CAPTURE_SINGULAR_KEY", 1)[0]
        self.assertIn("repeats(card) ? `<button type=\"button\" data-detail-stop class=\"aurora-quiet\" aria-label=\"Stop repeating: ${esc(titleOf(card))}\">Stop repeating</button>` : ''", detail)
        self.assertIn("node.querySelector('[data-detail-stop]')", detail)
        self.assertIn("if (stop) stop.onclick = () => leave('stop');", detail)
        self.assertIn("if (action === 'stop') return 'Reminder deleted';", js)

    def test_card_action_retries_with_a_fresh_request_after_sign_in(self):
        remove = js_block(source(AURORA_FEED_JS), "function removeAfterFeedAction(", "\n  function bringBack")
        # A Promise rejected with 401 cannot be reused after sign-in. Keep a
        # function and invoke it again so the retry carries the new session.
        self.assertIn("const run = () =>", remove)
        self.assertIn("V.showLogin(() => run().then(() => load(false))", remove)

    def removal(self, steps):
        """Runs removeAfterFeedAction with stubbed state and a manual clock.

        `steps` is JS run after a card is removed; it can call undo(), tick(ms)
        and fire('pagehide'). Returns the server calls, feed and toasts."""
        block = js_block(source(AURORA_FEED_JS), "  const UNDO_MS = 5000;", "\n  function bringBack")
        script = r"""
const calls = [], toasts = [], listeners = {}, timers = [];
let now = 0;
global.setTimeout = (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; };
global.clearTimeout = t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
const tick = ms => { now += ms; timers.filter(t => t.at <= now).forEach(t => { clearTimeout(t); t.fn(); }); };
global.window = { addEventListener: (type, fn) => { listeners[type] = fn; } };
const node = () => { const n = { className: '', attrs: {}, html: '', setAttribute(k, v) { n.attrs[k] = v; }, remove() { n.removed = true; }, querySelector() { return n.button; }, button: {} }; Object.defineProperty(n, 'innerHTML', { set(v) { n.html = v; }, get() { return n.html; } }); return n; };
global.document = { hidden: false, addEventListener: (type, fn) => { listeners[type] = fn; }, querySelectorAll: () => toasts.filter(t => !t.removed), createElement: () => node(), body: { appendChild: n => toasts.push(n) } };
const fire = type => listeners[type]();
const esc = s => s, render = () => {}, load = () => {}, toast = m => calls.push('toast:' + m), addSessionDismissed = () => {};
const cardKey = c => c.type + ':' + c.id, repeats = c => false, isGithubIssue = c => false, pinnedCount = () => 0;
const V = { showLogin() {} };
const dismissCard = card => { calls.push('dismiss:' + card.id); return Promise.resolve(); };
const feedAction = (card, action, days) => { calls.push(action + ':' + card.id + (days ? ':' + days : '')); return Promise.resolve(); };
const state = { cards: [{ type: 'reminder', id: 'a' }, { type: 'bookmark', id: 'b' }], stats: {} };
%s
const undo = () => toasts.filter(t => !t.removed).at(-1).button.onclick();
const message = () => toasts.at(-1).html;
%s
setImmediate(() => process.stdout.write(JSON.stringify({ calls, feed: state.cards.map(c => c.id), toasts: toasts.map(t => ({ html: t.html, role: t.attrs.role, removed: !!t.removed })) })));
""" % (block, steps)
        return run_node(script)

    def test_removed_card_waits_for_undo_before_reaching_the_server(self):
        result = self.removal("removeAfterFeedAction(state.cards[1], null, 'dismiss'); tick(4999);")
        self.assertEqual(result["calls"], [])
        self.assertEqual(result["feed"], ["a"])
        self.assertIn("Card deleted", result["toasts"][0]["html"])
        self.assertIn("data-undo>Undo</button>", result["toasts"][0]["html"])
        self.assertEqual(result["toasts"][0]["role"], "status")
        sent = self.removal("removeAfterFeedAction(state.cards[1], null, 'dismiss'); tick(5000);")
        self.assertEqual(sent["calls"], ["dismiss:b"])
        self.assertTrue(sent["toasts"][0]["removed"])

    def test_undo_puts_the_card_back_and_sends_nothing(self):
        result = self.removal("removeAfterFeedAction(state.cards[0], null, 'remind_later', 3); undo(); tick(10000);")
        self.assertEqual(result["calls"], [])
        self.assertEqual(result["feed"], ["a", "b"])
        self.assertIn("Snoozed for 3 days", result["toasts"][0]["html"])

    def test_a_waiting_removal_is_sent_when_another_starts_or_the_page_closes(self):
        both = self.removal("removeAfterFeedAction(state.cards[0], null, 'remind_later'); removeAfterFeedAction(state.cards[0], null, 'dismiss');")
        self.assertEqual(both["calls"], ["remind_later:a"])
        self.assertIn("Snoozed until tomorrow", both["toasts"][0]["html"])
        self.assertEqual(both["feed"], [])
        closing = self.removal("removeAfterFeedAction(state.cards[0], null, 'dismiss'); fire('pagehide');")
        self.assertEqual(closing["calls"], ["dismiss:a"])
        self.assertIn("Reminder completed", closing["toasts"][0]["html"])

    def edit_helpers(self, expression):
        js = source(AURORA_FEED_JS)
        block = js_block(js, "  const EDIT_ENDPOINT = ", "\n  function editCard(card) {")
        return run_node(block + f"\nprocess.stdout.write(JSON.stringify({expression}));")

    def test_edit_form_starts_from_what_the_card_says(self):
        reminder = {"type": "reminder", "title": "Renew passport", "metadata": {"due_date": "2026-11-02T00:00:00.000Z", "recurrence": "yearly"}}
        self.assertEqual(self.edit_helpers(f"editValues({json.dumps(reminder)})"),
                         {"title": "Renew passport", "due_date": "2026-11-02", "recurrence": "yearly"})
        work = {"type": "work", "title": "Launch", "metadata": {"items": [{"text": "Draft", "completed": True}, {"text": "Ship", "completed": False}]}}
        self.assertEqual(self.edit_helpers(f"editValues({json.dumps(work)})"), {"title": "Launch", "items_text": "Draft\nShip"})
        family = {"type": "family", "title": "Mum", "body": "Back from the trip"}
        self.assertEqual(self.edit_helpers(f"editValues({json.dumps(family)})"), {"person": "Mum", "content": "Back from the trip"})
        bookmark = {"type": "bookmark", "title": "Docs", "body": "", "metadata": {"url": "https://example.com"}}
        self.assertEqual(self.edit_helpers(f"editValues({json.dumps(bookmark)})"), {"title": "Docs", "url": "https://example.com", "notes": ""})
        # GitHub issues and files can't be edited here.
        self.assertEqual(self.edit_helpers("[canEdit({ type: 'kanban' }), canEdit({ type: 'file' }), canEdit({ type: 'talking_point' })]"), [False, False, True])

    def test_edit_sends_only_what_changed(self):
        before = {"title": "Call the dentist", "due_date": "2026-10-16", "recurrence": ""}
        title_only = {**before, "title": "Call the dentist at 5"}
        # The date is left out, so a time of day set by an assistant survives.
        self.assertEqual(self.edit_helpers(f"editChanges('reminder', {json.dumps(before)}, {json.dumps(title_only)})"), {"title": "Call the dentist at 5"})
        cleared = {**before, "due_date": ""}
        self.assertEqual(self.edit_helpers(f"editChanges('reminder', {json.dumps(before)}, {json.dumps(cleared)})"), {"due_date": ""})
        # A checklist goes as plain lines, which the server matches to keep ticks.
        work = self.edit_helpers("editChanges('work', { title: 'Launch', items_text: 'Draft\\nShip' }, { title: 'Launch', items_text: 'Draft\\n\\n Ship \\nCelebrate' })")
        self.assertEqual(work, {"items": ["Draft", "Ship", "Celebrate"]})
        # A Misc card's title is its section_title.
        self.assertEqual(self.edit_helpers("editChanges('talking_point', { title: 'A', content: 'x' }, { title: 'B', content: 'x' })"), {"section_title": "B"})

    def test_due_date_field_shows_the_reminders_day(self):
        # Midnight UTC is a date-only reminder; it must not slip a day west of UTC.
        result = run_node(js_block(source(AURORA_FEED_JS), "  function dueDateInputValue(value) {", "\n  // The card's current values")
                          + "\nprocess.stdout.write(JSON.stringify([dueDateInputValue('2026-10-16T00:00:00.000Z'), dueDateInputValue(''), dueDateInputValue('nonsense')]));")
        self.assertEqual(result, ["2026-10-16", "", ""])

    def test_detail_view_offers_edit_where_a_card_can_be_edited(self):
        js = source(AURORA_FEED_JS)
        detail = js.split("function detail(card) {", 1)[1].split("\n  const CAPTURE_SINGULAR_KEY", 1)[0]
        self.assertIn("const editButton = canEdit(card) ?", detail)
        self.assertIn('data-detail-edit aria-label="Edit ${esc(titleOf(card))}">Edit</button>', detail)
        # The demo asks visitors to sign in rather than editing a sample card.
        self.assertIn("if (SANDBOX) sandboxSignInGate(); else editCard(card);", detail)
        edit = js_block(js, "  function editCard(card) {", "\n  function detail(card) {")
        self.assertIn("V.api(`${EDIT_ENDPOINT[card.type]}/${card.id}`, { method: 'PATCH', body: JSON.stringify(changes) })", edit)
        self.assertIn("fields.querySelector('input[name=\"attachment\"]')?.closest('label')?.remove();", edit)
        self.assertIn("V.showLogin(() => save().then(done)", edit)
        self.assertIn(".aurora-edit{", source(ROOT / "public" / "vault" / "assets" / "aurora-feed.css"))

    def test_a_reload_does_not_bring_back_a_card_waiting_for_undo(self):
        load = js_block(source(AURORA_FEED_JS), "  async function load(more) {", "\n  function modal(")
        self.assertIn("const waiting = pendingRemoval?.key;", load)
        self.assertIn("cardKey(c) !== waiting", load.split("if (SANDBOX)", 1)[1].split("else {", 1)[0])
        self.assertIn("!dismissed.has(cardKey(c)) && cardKey(c) !== waiting", load)

    def test_aurora_feed_supports_pinning_with_a_three_card_cap(self):
        js = source(AURORA_FEED_JS)
        css = source(AURORA_FEED_CSS)
        for token in (
            "const DEFAULT_MAX_PINNED = 3;",
            "const maxPinned = () => Number(state.stats.max_pinned || DEFAULT_MAX_PINNED);",
            "const pinnedCount = () => Number(state.stats.pinned_cards || 0);",
            "const PINNED_COLLAPSED_KEY = 'feed-pinned-collapsed';",
            "function pinnedCollapsed()", "function setPinnedCollapsed(",
            "function pinnedSectionHtml(pinnedCards)", "data-pinned-toggle",
            "function pin(card)", "feedAction(card, old ? 'unpin' : 'pin')",
            "pinLimitReached", "disabled aria-disabled=\"true\"",
            "data-pin", "PIN_ICON",
        ):
            self.assertIn(token, js)
        # Pinning (not unpinning) must be blocked client-side once the cap is hit.
        pin_fn = js.split("function pin(card) {", 1)[1].split("\n  function bind", 1)[0]
        self.assertIn("if (!old && pinnedCount() >= maxPinned())", pin_fn)
        self.assertIn("toast(`You can only pin up to ${maxPinned()} cards. Unpin one first.`)", pin_fn)
        for token in (
            ".aurora-pin{", ".aurora-pin.is-pinned{", ".aurora-pin:disabled{",
            ".aurora-pinned-section{", ".aurora-pinned-toggle{", ".aurora-pinned-list{",
            # Regression guard: a bare .aurora-pinned-list{display:grid} rule silently
            # overrides the `hidden` attribute at equal CSS specificity, so the
            # collapse toggle must have an explicit [hidden] override to actually hide it.
            ".aurora-pinned-list[hidden]{display:none}",
        ):
            self.assertIn(token, css)

    def test_aurora_overview_has_favorites_and_shared_media_visual_controls(self):
        js = source(AURORA_FEED_JS)
        css = source(AURORA_FEED_CSS)
        for token in (
            "favoritesOnly: false", "p.set('liked', 'true')", "data-favorites-toggle",
            "data-favorites-count", "liked_cards", "aria-pressed=\"${state.favoritesOnly}\"",
            "const MEDIA_VISUALS_STORAGE_KEY = 'feed-media-visuals'",
            "localStorage.getItem(MEDIA_VISUALS_STORAGE_KEY)",
            "localStorage.setItem(MEDIA_VISUALS_STORAGE_KEY", "data-media-visuals-toggle",
            "const mediaEnabled = mediaVisualsEnabled()", "window.addEventListener('storage'",
        ):
            self.assertIn(token, js)
        for token in (".aurora-feed-views", ".aurora-view-toggle", "min-height:44px", "overscroll-behavior-x:contain", "prefers-reduced-motion"):
            self.assertIn(token, css)

    def test_aurora_mobile_feed_contract_keeps_actions_visible_and_text_wrappable(self):
        css = source(AURORA_FEED_CSS)
        js = source(AURORA_FEED_JS)
        for token in (
            "@media(max-width:640px)", "justify-content:space-between",
            "min-height:44px", "overflow-wrap:anywhere", "overscroll-behavior-x:contain",
            "prefers-reduced-motion", ".aurora-feed button:focus-visible", "grid-column:1/-1",
            "--aurora-calm-action", ".aurora-card-actions .aurora-quiet",
            ".aurora-card-actions .aurora-quiet:hover",
        ):
            self.assertIn(token, css)
        tokens = source(AURORA_CSS)
        for token in (
            "--aurora-action-primary", "--aurora-action-primary-hover",
        ):
            self.assertIn(token, tokens)
        self.assertNotIn("--aurora-action-secondary", tokens)
        for token in ("aurora-header-actions", "actionButtonsHtml", "hasPrimaryAction", "aurora-dismiss"):
            self.assertIn(token, js)

    def test_aurora_cards_expose_persistent_delete_action(self):
        js = source(AURORA_FEED_JS)
        css = source(AURORA_FEED_CSS)
        # Delete is a real /api/feed state transition (the "dismiss" action),
        # not a local-only card hide.
        action_buttons = js.split("function actionButtonsHtml(card) {", 1)[1].split("\n  function cardHtml", 1)[0]
        self.assertIn("data-dismiss", action_buttons)
        self.assertIn("${dismissLabel(card)}", action_buttons)
        self.assertIn("removeAfterFeedAction(card, el, 'dismiss')", js)
        feed_action = js.split("async function feedAction(card, action, days) {", 1)[1].split("\n  async function primary", 1)[0]
        self.assertIn("V.api('/api/feed'", feed_action)
        self.assertIn("JSON.stringify({ action, item_type: card.type, item_id: card.id, ...(days ? { days } : {}) })", feed_action)
        self.assertIn(".aurora-dismiss", css)

    def test_feed_filters_search_and_capture_selection_are_accessible(self):
        js = source(AURORA_FEED_JS)
        for token in (
            'aria-pressed="${active === key}"',
            "query: ''", "p.set('query', state.query)", "function openSearch()",
            'type="search" name="query"', "data-clear-search",
            'role="radiogroup" aria-label="Card type"',
            'role="radio" aria-checked="${key === type}"',
            "x.setAttribute('aria-checked', String(selected))",
        ):
            self.assertIn(token, js)
        self.assertNotIn("prompt('Search loaded cards')", js)

    def test_feed_sort_control_sends_the_choice_and_remembers_it(self):
        js = source(AURORA_FEED_JS)
        for token in (
            'role="group" aria-label="Sort cards"',
            'data-sort="${key}" aria-pressed="${state.sort === key}"',
            "['ai', 'AI',", "['newest', 'Date added',",
            "if (state.view === 'active') p.set('sort', state.sort)",
            "localStorage.setItem(SORT_STORAGE_KEY, sort)",
            "track('feed.sort', null, feedContext())",
            "sort: state.sort,",
        ):
            self.assertIn(token, js)
        # savedSort() runs while `state` is built, so its storage key must be
        # declared before it; otherwise the try/catch hides a ReferenceError
        # and the saved choice is silently ignored.
        self.assertLess(js.index("const SORT_STORAGE_KEY"), js.index("const state = {"))
        self.assertIn(".aurora-sort-option.is-active", source(AURORA_FEED_CSS))

    def test_feed_modal_moves_focus_traps_tab_and_restores_the_opener(self):
        js = source(AURORA_FEED_JS)
        modal_block = js.split("function modal(content, className, onClose) {", 1)[1].split("\n  function openSearch", 1)[0]
        for token in (
            "const opener = document.activeElement", "event.key === 'Escape'",
            "event.key !== 'Tab'", "closeButton.focus()", "opener?.focus",
            "const focusable = () =>",
        ):
            self.assertIn(token, modal_block)

    def test_aurora_media_preview_contract_supports_youtube_links_and_attachments(self):
        css = source(AURORA_FEED_CSS)
        js = source(AURORA_FEED_JS)
        for token in (
            "YOUTUBE_HOSTS", "youtubeVideoId", "i.ytimg.com/vi/${videoId}/hqdefault.jpg",
            "metadata.attachments", "aurora-media-preview", "data-interactive", "target=\"_blank\"",
            "function mediaKind(card)", "function mediaIndicatorHtml(card)", "aurora-media-indicator-${media.kind}",
            "const mediaIndicator = mediaEnabled ? '' : mediaIndicatorHtml(card)",
        ):
            self.assertIn(token, js)
        for token in (".aurora-media-preview", ".aurora-media-meta", ".aurora-media-indicator", "max-height:210px", "prefers-reduced-motion"):
            self.assertIn(token, css)

    def test_retired_kanban_page_is_gone_and_old_links_fall_back_to_the_feed(self):
        # The standalone Kanban page became unreachable when the vault became a
        # single feed; GitHub Issues onboarding (integrations.js) replaced it.
        assets = ROOT / "public" / "vault" / "assets"
        self.assertFalse((assets / "kanban.js").exists())
        self.assertFalse((assets / "kanban.css").exists())
        html = source(VAULT_INDEX)
        for marker in ("kanban.js", "kanban.css", 'id="page-kanban"', 'id="kanban-app"'):
            self.assertNotIn(marker, html)
        # A saved 'kanban' tab or #kanban link must not hide every page.
        self.assertIn("if (!document.getElementById(`page-${name}`)) name = 'overview';", source(VAULT_JS))

    def test_retired_reminders_page_is_gone_and_old_links_fall_back_to_the_feed(self):
        # The standalone Reminders page had no link since the vault became a
        # single feed, and it knew nothing about recurring reminders or
        # snoozes. Reminders live in the feed.
        assets = ROOT / "public" / "vault" / "assets"
        self.assertFalse((assets / "reminders.js").exists())
        self.assertFalse((assets / "reminders.css").exists())
        html = source(VAULT_INDEX)
        for marker in ("reminders.js", "reminders.css", 'id="page-reminders"', 'id="reminders-app"'):
            self.assertNotIn(marker, html)
        # A saved 'reminders' tab or #reminders link must not hide every page.
        self.assertIn("if (!document.getElementById(`page-${name}`)) name = 'overview';", source(VAULT_JS))

    def test_api_driven_vault_frontend_files_exist(self):
        assets = ROOT / "public" / "vault" / "assets"
        for name in ("vault.js", "work.js", "family.js",
                     "bookmarks.js", "talking-points.js"):
            text = source(assets / name)
            self.assertIn("/api/", text, name)

    def test_vault_html_is_a_thin_shell_without_markdown_content(self):
        html = source(VAULT_INDEX)
        for marker in ("Make Cardlake into a product", "Australia Use Case — Insights Generation",
                       "Business Benefits from GenAI"):
            self.assertNotIn(marker, html)
        for container in ("dashboard-app", "work-app", "family-app",
                          "bookmarks-app", "talking-points-app"):
            self.assertIn(f'id=\"{container}\"', html)

    def test_vault_shell_has_accessible_cardle_brand_and_professional_info_sections(self):
        html = source(VAULT_INDEX)
        css = source(ROOT / "public" / "vault" / "assets" / "learnings.css")
        for token in (
            'class="cardle-brand"',
            'aria-label="Cardlake home"',
            '<svg',
            'aria-hidden="true"',
            'id="about"',
            'id="what-this-is-about"',
            'id="support"',
            'About Cardlake',
            'What this is about',
            '<h3>How to use this tool</h3>',
            'id="page-about"',
            "showPage('about')",
            'href="#about"',
        ):
            self.assertIn(token, html)
        self.assertNotIn('Support &amp; help', html)
        self.assertNotIn('data-cardle-info-toggle', html)
        self.assertNotIn('id="cardle-info"', html)
        # About is a standalone route, so it must not be prepended to the feed.
        self.assertLess(html.index('id="page-overview"'), html.index('id="page-about"'))
        for token in (
            '.cardle-brand',
            '.cardle-mark',
            '.cardle-info',
            '.cardle-info-card',
            '.cardle-help-list',
            '@media (prefers-reduced-motion: reduce)',
        ):
            self.assertIn(token, css)
        # The header action is a compact navigation link, not an unstyled or
        # oversized pill-shaped button.
        info_trigger_css = css.split('.cardle-info-trigger {', 1)[1].split('}', 1)[0]
        self.assertIn('display: inline-flex;', info_trigger_css)
        self.assertIn('text-decoration: none;', info_trigger_css)
        self.assertNotIn('border-radius: 999px;', info_trigger_css)

    def test_assistant_panel_is_called_connect_ai_everywhere_users_read_it(self):
        # "Ask AI" read like a chat feature inside Cardlake; the panel is where
        # assistants get connected. Every user-facing mention must agree.
        self.assertIn('<h3 id="cardle-tokens-title" tabindex="-1">Connect your AI</h3>', source(VAULT_JS))
        user_facing = [*sorted((ROOT / "public").rglob("*.html")), *sorted((ROOT / "public").rglob("*.js")),
                       ROOT / "docs" / "MCP_SERVER.md"]
        stale = [str(path.relative_to(ROOT)) for path in user_facing if "Ask AI" in source(path)]
        self.assertEqual(stale, [])

    def test_mobile_header_keeps_the_mcp_control_visible(self):
        html = source(VAULT_INDEX)
        js = source(VAULT_JS)
        # The base legacy shell hid this button at <=640px. The later mobile
        # override deliberately wins, while preserving the short "Connect AI" label.
        self.assertIn('class="cardle-api-tokens-btn" title="Connect Claude, ChatGPT or another AI assistant to Cardlake">Connect AI</button>', js)
        self.assertIn('.cardle-api-tokens-btn{display:inline-flex', html)
        self.assertGreater(
            html.rindex('.cardle-api-tokens-btn{display:inline-flex'),
            html.index('.cardle-api-tokens-btn{display:none}'),
        )
    def test_public_ui_uses_cardle_branding(self):
        public_files = [
            VAULT_INDEX,
            *(ROOT / "public" / "vault" / "assets").glob("*.js"),
        ]
        combined = "\n".join(source(path) for path in public_files)
        self.assertIn("Cardlake", combined)
        obsolete = [
            "Learnings" + " Hub",
            "Obsidian" + " Vault",
            "Obsidian" + " vault",
            "window." + "Vault",
            "Vault" + "Tabs",
            "Learnings" + "HubApp",
        ]
        for marker in obsolete:
            self.assertNotIn(marker, combined)

    def test_vault_shell_favicon_matches_the_account_pages(self):
        # Regression: the feed page had no <link rel="icon">, so the browser
        # tab icon reverted to the default the moment someone went from
        # signing in to the real app.
        vault_icon = re.search(r'<link rel="icon" href="([^"]+)"', source(VAULT_INDEX))
        self.assertIsNotNone(vault_icon)
        for page in ("signin.html", "setup.html"):
            self.assertIn(f'<link rel="icon" href="{vault_icon.group(1)}"', source(ROOT / "public" / page), page)

    def test_sandbox_page_pads_to_cancel_the_feed_grids_negative_margin(self):
        # Regression: .aurora-feed{margin:-16px} (aurora-feed.css) exists to
        # cancel out the real app shell's .main{padding:16px} for edge-to-edge
        # bleed. The sandbox page has no such padding, so without matching it
        # here the negative margin yanks the whole feed up by 16px, clipping
        # the sandbox banner's top edge against the iframe boundary.
        html = source(SANDBOX_HTML)
        self.assertIn("window.CARDLE_SANDBOX = true;", html)
        self.assertIn(".demo-wrap{max-width:960px;width:100%;margin:0 auto;padding:16px}", html)

    def test_sandbox_signin_links_break_out_of_the_iframe_to_the_full_page(self):
        # Regression: these links used to have no `target`, so clicking them
        # navigated the iframe's own browsing context instead of the parent
        # tab -- the real, authenticated app rendered trapped inside the
        # landing page's small device-frame mockup instead of taking over
        # the full page.
        js = source(AURORA_FEED_JS)
        self.assertEqual(js.count('href="/vault/index.html?signin=1" target="_top"'), 2)

    def test_sandbox_mode_seeds_a_local_feed_and_never_hits_the_real_api(self):
        js = source(AURORA_FEED_JS)
        self.assertIn("const SANDBOX = !!window.CARDLE_SANDBOX;", js)
        self.assertIn("const SANDBOX_SEED = [", js)
        feed_action = js.split("async function feedAction(card, action, days) {", 1)[1].split("\n  async function primary", 1)[0]
        self.assertIn("if (SANDBOX)", feed_action)
        load_fn = js.split("async function load(more) {", 1)[1].split("\n  function shell", 1)[0]
        self.assertIn("if (SANDBOX)", load_fn)

    # --- Legacy nav / feed UI polish (formerly test_vault_ui_contracts.py) ---

    def test_legacy_top_horizontal_nav_is_removed(self):
        html = source(VAULT_INDEX)
        self.assertNotIn('<nav class="nav">', html)
        self.assertNotIn('class="nav"', html)

    def test_feed_card_actions_use_same_calm_blue_not_red(self):
        shared_css = source(AURORA_CSS)
        feed_css = source(AURORA_FEED_CSS)
        self.assertIn("--aurora-calm-action", shared_css)
        self.assertIn("--grad-brand", shared_css)
        self.assertIn("oklch(64% .12 258)", shared_css)
        self.assertIn("oklch(60% .13 262)", shared_css)
        self.assertIn("oklch(70% .1 250)", shared_css)
        self.assertNotIn("--aurora-calm-action:linear-gradient", feed_css)
        self.assertIn(".aurora-card-actions .aurora-action", feed_css)
        self.assertIn(".aurora-card-actions .aurora-dismiss", feed_css)
        for loud_red in ("#f87171", "#ef4444", "255, 59, 48"):
            self.assertNotIn(loud_red, feed_css)
            self.assertNotIn(loud_red, shared_css)

    def test_feed_swipe_works_on_mobile_and_action_button_area(self):
        css = source(AURORA_FEED_CSS)
        js = source(AURORA_FEED_JS)
        bind_block = js.split("r.querySelectorAll('.aurora-feed-card').forEach(el => {", 1)[1].split("\n    });", 1)[0]
        self.assertIn("touch-action: pan-y", css)
        self.assertIn("const isSwipeBlockedTarget", bind_block)
        self.assertIn("closest('a, button, [data-interactive], [data-like]')", bind_block)
        self.assertNotIn("closest('button, a, [data-interactive]')", bind_block)
        self.assertIn("e.preventDefault()", bind_block)
        self.assertIn("suppressClick", bind_block)

    def test_feed_card_actions_do_not_repeat_swipe_hint_copy(self):
        css = source(AURORA_FEED_CSS)
        js = source(AURORA_FEED_JS)
        card_block = js.split("function cardHtml(card, index) {", 1)[1].split("\n  function shell", 1)[0]
        action_block = js.split("function actionButtonsHtml(card) {", 1)[1].split("\n  function cardHtml", 1)[0]
        self.assertIn("<span aria-hidden=\"true\">←</span> ${dismissLabel(card)}", action_block)
        self.assertIn("Snooze", action_block)
        self.assertIn("<span aria-hidden=\"true\">→</span>", action_block)
        self.assertNotIn(">Delete</button>", action_block)
        self.assertNotIn("Swipe → Remind later", card_block)
        self.assertNotIn("Swipe ← Delete", card_block)
        self.assertNotIn(".aurora-swipe-hint", css)
        self.assertIn("grid-template-columns:minmax(0,1fr)", css)

    def test_detail_modal_uses_delete_and_watch_later_actions(self):
        js = source(AURORA_FEED_JS)
        detail_block = js.split("function detail(card) {", 1)[1].split("\n  function captureFields", 1)[0]
        self.assertIn("data-detail-dismiss", detail_block)
        self.assertIn("data-detail-remind", detail_block)
        self.assertIn("<span aria-hidden=\"true\">←</span> ${dismissLabel(card)}", detail_block)
        self.assertIn("Snooze", detail_block)
        self.assertIn("<span aria-hidden=\"true\">→</span>", detail_block)
        self.assertIn("leave('dismiss')", detail_block)
        self.assertIn("leave('remind_later', days)", detail_block)
        self.assertNotIn("Mark watched", detail_block)
        self.assertNotIn("data-detail-action", detail_block)

    def test_feed_has_no_sidebar_or_rail_navigation(self):
        # The "Today Command Center" (donut + queues) shipped once, was
        # accidentally wiped by an unrelated "restore from backup" commit, and
        # was never rebuilt. The right-hand rail that replaced it (today's
        # progress donut + a saved-cards list) was later removed deliberately
        # (too little value for the space it took on desktop), leaving the
        # single-column feed as the whole story -- no sidebar, no rail.
        js = source(AURORA_FEED_JS)
        self.assertNotIn('class="aurora-rail"', js)
        self.assertNotIn("aurora-donut", js)
        self.assertNotIn('class="aurora-saved"', js)
        # The old duplicate VAULT category list must NOT be present either.
        self.assertNotIn("VAULT</small>", js)
        self.assertNotIn("aurora-side-row", js)
        self.assertNotIn("aurora-sidebar", js)
        self.assertNotIn("aurora-sidebar", js)


INTEGRATIONS_JS = ROOT / "public" / "vault" / "assets" / "integrations.js"
INTEGRATIONS_CSS = ROOT / "public" / "vault" / "assets" / "integrations.css"


class IntegrationOnboardingFrontendTests(unittest.TestCase):
    """The Integrations chip group in the feed and the one-time onboarding
    sheet. The server side of the same flow is exercised against real
    Postgres in test_integrations.py."""

    def test_both_vault_pages_load_the_onboarding_sheet_before_the_feed(self):
        for page in (VAULT_INDEX, SANDBOX_HTML):
            html = source(page)
            self.assertIn("/vault/assets/integrations.css", html, page)
            self.assertLess(html.index("/vault/assets/integrations.js"), html.index("/vault/assets/aurora-feed.js"), page)

    def test_client_steps_match_the_server_registry(self):
        # The sheet's progress steps must be the registry's onboarding steps
        # plus the client-only "done" screen, or resuming at a saved step
        # would land on a step the sheet cannot render.
        result = subprocess.run(
            ["node", "-e", "process.stdout.write(JSON.stringify(require('./api/_lib/integration-registry').INTEGRATIONS.github_issues.onboardingSteps))"],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        server_steps = json.loads(result.stdout)
        progress = re.search(r"const PROGRESS = \[(.*?)\];", source(INTEGRATIONS_JS)).group(1)
        client_steps = re.findall(r"\['(\w+)', '[^']+'\]", progress)
        self.assertEqual(client_steps, server_steps + ["done"])

    def test_sheet_saves_progress_and_resumes_by_lifecycle_status(self):
        js = source(INTEGRATIONS_JS)
        self.assertIn("/onboarding`, { method: 'POST', body: JSON.stringify({ step }) }", js)
        start = js.split("function startStep(integration) {", 1)[1].split("\n  }", 1)[0]
        self.assertIn("integration.status === 'onboarding') return integration.onboarding_step || 'intro'", start)
        self.assertIn("integration.status === 'disconnected') return 'connect'", start)
        # Onboarding finishes by connecting GitHub through the real endpoints;
        # there is no Cardlake-only ("native") board any more.
        self.assertNotIn("/native`", js)
        self.assertIn("V.api('/api/integrations/github', { method: 'POST'", js)
        self.assertIn("V.api('/api/integrations/github/sync', { method: 'POST' })", js)
        # Accessible dialog: labelled, focus moves to each step's heading, Escape closes.
        self.assertIn('role="dialog" aria-modal="true" aria-labelledby="integ-title"', js)
        self.assertIn("#integ-title')?.focus(", js)
        self.assertIn("event.key === 'Escape'", js)
        # HTML `pattern` compiles with the regex v flag: an unescaped hyphen in a
        # character class makes the browser silently drop the whole pattern.
        pattern = re.search(r"const REPO_PATTERN = '([^']+)';", js).group(1)
        self.assertNotRegex(pattern, r"(?<!\\\\)-\]")
        self.assertIn('pattern="${REPO_PATTERN}"', js)

    def test_coming_soon_integrations_are_announced_but_not_clickable(self):
        js = source(AURORA_FEED_JS)
        self.assertIn("COMING_SOON_INTEGRATIONS.map(comingSoonChipHtml)", js)
        self.assertIn("name: 'Email'", js)
        chip = js.split("function comingSoonChipHtml(", 1)[1].split("\n  }", 1)[0]
        # A span with no data-filter / data-integration-setup: nothing to click into.
        self.assertIn("<span class=\"aurora-chip aurora-chip-integration is-soon\"", chip)
        self.assertNotIn("data-filter", chip)
        self.assertNotIn("data-integration-setup", chip)
        self.assertIn(".aurora-chip-integration.is-soon{", source(INTEGRATIONS_CSS))

    def test_integration_card_types_get_their_own_separated_chip_group(self):
        js = source(AURORA_FEED_JS)
        # Core chips skip integration-owned types; the group follows a divider.
        self.assertIn("key !== 'file' && !gated.has(key)", js)
        self.assertIn("+ integrationChipsHtml()", js)
        group = js.split("function integrationChipsHtml() {", 1)[1].split("\n  function acknowledge", 1)[0]
        for token in ('class="aurora-chip-divider"', 'role="group" aria-label="Integrations"', "data-integration-setup", "aurora-chip-new"):
            self.assertIn(token, group)
        self.assertIn("window.CardleIntegrations.open(integration", js)
        self.assertIn("state.integrations = data.integrations || []", js)
        # The group sits in normal flow: it used to be sticky at the row's end,
        # where it covered the last category chips ("Misc") on a laptop.
        self.assertNotIn("position:sticky", source(INTEGRATIONS_CSS).split(".aurora-chip-group{", 1)[1].split("}", 1)[0])

    def test_new_cue_clears_only_through_the_acknowledge_endpoint_and_never_in_the_demo(self):
        js = source(AURORA_FEED_JS)
        ack = js.split("function acknowledge(integration) {", 1)[1].split("\n  }", 1)[0]
        self.assertIn("integration.acknowledged || SANDBOX) return", ack)
        self.assertIn("/acknowledge`, { method: 'POST' }", ack)

    def test_capture_never_offers_integration_owned_card_types(self):
        # GitHub issues are created on GitHub, never by hand in Cardlake.
        js = source(AURORA_FEED_JS)
        creatable = js.split("function creatableTypes() {", 1)[1].split("\n  }", 1)[0]
        self.assertIn("!gated.has(key)", creatable)
        self.assertIn("const INTEGRATION_CARD_TYPES = new Set(['kanban']);", js)
        self.assertIn("const creatable = creatableTypes();", js)

    def test_github_issue_cards_show_labels_and_a_safe_link_back_to_github(self):
        js = source(AURORA_FEED_JS)
        meta = js.split("function issueMetaHtml(card) {", 1)[1].split("\n  }", 1)[0]
        self.assertIn("if (!isGithubIssue(card)) return '';", meta)
        self.assertIn("const isGithubIssue = card => card.type === 'kanban' && card.metadata?.source === 'github';", js)
        # The URL goes through the same http(s)-only, no-credentials filter as media links.
        self.assertIn("safeMediaUrl(card.metadata.external_url)", meta)
        self.assertIn('rel="noopener noreferrer"', meta)
        self.assertIn("esc(label)", meta)
        self.assertEqual(js.count("${issueMetaHtml(card)}"), 2)  # feed card + detail modal

    def test_filtered_integration_shows_status_bar_with_sync_and_manage(self):
        js = source(AURORA_FEED_JS)
        bar = js.split("function integrationBarHtml() {", 1)[1].split("\n  }", 1)[0]
        self.assertIn("i.card_type === state.filter && isLive(i)", bar)
        self.assertIn("window.CardleIntegrations.statusLine(integration)", bar)
        # The demo has no server to sync with or manage.
        self.assertIn("SANDBOX ? ''", bar)
        self.assertIn("${integrationBarHtml()}<div class=\"aurora-list\">", js)
        self.assertIn("window.CardleIntegrations.sync(integration)", js)
        self.assertIn("window.CardleIntegrations.manage(integration", js)

    def test_manage_panel_reconnects_via_the_connect_step_and_confirms_disconnect_inline(self):
        js = source(INTEGRATIONS_JS)
        manage = js.split("function manage(integration, { onChanged } = {}) {", 1)[1].split("\n  // integration: the public view", 1)[0]
        self.assertIn("open(integration, { startAt: 'connect'", manage)
        self.assertIn("V.api(copy.connectionPath, { method: 'DELETE' })", manage)
        # Embedded browsers silently suppress native dialogs.
        self.assertNotIn("window.confirm", manage)
        self.assertIn("integ-confirm", manage)
        self.assertIn("show(startAt || startStep(integration))", js)
        self.assertIn("window.CardleIntegrations = { open, manage, sync, statusLine };", js)

    def test_background_sync_is_throttled_signed_in_only_and_never_yanks_the_page(self):
        js = source(AURORA_FEED_JS)
        self.assertIn("const AUTO_SYNC_AFTER_MS = 15 * 60e3;", js)
        due = js.split("function autoSyncDue(integration) {", 1)[1].split("\n  }", 1)[0]
        # Both the last successful sync and this session's last attempt count,
        # so a broken token is retried at most once per interval.
        self.assertIn("Math.max(lastSync, lastAttempt)", due)
        run = js.split("async function autoSync() {", 1)[1].split("\n  }", 1)[0]
        self.assertIn("SANDBOX", run)
        self.assertIn("await V.checkAuth()", run)
        self.assertIn("markAutoSyncAttempt(integration.id)", run)
        self.assertIn("window.scrollY < 120 && !document.querySelector('.aurora-overlay')", run)
        # Only after a first-page load renders, never while paginating.
        self.assertIn("render();\n      if (!more) autoSync();", js)

    def test_github_issue_cards_are_labelled_as_github_issues_not_kanban(self):
        js = source(AURORA_FEED_JS)
        self.assertIn("kanban: [ICONS.kanban, 'GitHub issue',", js)
        self.assertNotIn("'Kanban'", js)
        self.assertNotIn("Kanban", source(INTEGRATIONS_JS))


LEGACY_TALKING_JS = ROOT / "public" / "vault" / "assets" / "talking-points.js"
MCP_CARDS_HTML = ROOT / "api" / "_lib" / "mcp-app" / "cards.html"


class MiscAndDeleteCopyTests(unittest.TestCase):
    """People see the talking_point card type as "Misc", and a card's remove
    action as "Delete". The identifiers behind them (talking_point,
    /api/talking-points, the "dismiss" feed action) are stored in rows and
    used by connected assistants, so they stay as they are."""

    def test_talking_point_cards_are_labelled_misc_in_the_feed(self):
        js = source(AURORA_FEED_JS)
        # One label drives the badge, filter chip, capture tile and detail modal.
        self.assertIn("talking_point: [ICONS.talking_point, 'Misc',", js)
        self.assertIn("talking_point: '/api/talking-points'", js)

    def test_misc_capture_form_does_not_ask_for_a_talking_point(self):
        js = source(AURORA_FEED_JS)
        fields = js.split("if (type === 'talking_point') return", 1)[1].split("if (type === 'file')", 1)[0]
        self.assertIn('name="section_title"', fields)
        self.assertIn('name="content"', fields)
        self.assertNotIn("Talking", fields)

    def test_legacy_talking_tab_is_titled_misc(self):
        js = source(LEGACY_TALKING_JS)
        self.assertRegex(js, r"title:'[^']*Misc'")
        self.assertIn("singular:'misc card'", js)
        self.assertIn("path:'/api/talking-points'", js)

    def test_nothing_people_read_says_talking_points(self):
        public = ROOT / "public"
        # api/ builds card subtitles and MCP tool text, so it counts too.
        user_facing = [*sorted(public.rglob("*.html")), *sorted(public.rglob("*.js")), MCP_CARDS_HTML,
                       *sorted((ROOT / "api").rglob("*.js")),
                       ROOT / "README.md", ROOT / "docs" / "MCP_SERVER.md"]
        # Identifiers are spelled with _ or -, so only prose matches.
        stale = [str(path.relative_to(ROOT)) for path in user_facing
                 if re.search(r"talking points?\b", source(path), re.I)]
        self.assertEqual(stale, [])

    def test_card_remove_action_reads_delete_on_the_card_swipe_and_detail(self):
        js = source(AURORA_FEED_JS)
        action_block = js.split("function actionButtonsHtml(card) {", 1)[1].split("\n  function cardHtml", 1)[0]
        card_block = js.split("function cardHtml(card, index) {", 1)[1].split("\n  function shell", 1)[0]
        detail_block = js.split("function detail(card) {", 1)[1].split("\n  function captureFields", 1)[0]
        self.assertIn("card.type === 'reminder' ? 'Complete' : 'Delete';", js)
        self.assertIn('aria-label="${dismissLabel(card)}: ${esc(titleOf(card))}"', action_block)
        self.assertIn('aria-label="${dismissLabel(card)}: ${esc(titleOf(card))}"', detail_block)
        self.assertIn("'Complete ↙' : 'Delete ↙'", card_block)
        self.assertIn("swipe left to ${dismissLabel(card).toLowerCase()}", card_block)
        for block in (action_block, card_block, detail_block):
            self.assertNotRegex(block, r"(?<![A-Za-z_])Dismiss")
            self.assertNotIn("to dismiss", block)
        # The action sent to the server is unchanged.
        self.assertIn("removeAfterFeedAction(card, el, 'dismiss')", js)
        self.assertIn("leave('dismiss')", detail_block)

    def test_demo_copy_says_delete_not_dismiss(self):
        js = source(AURORA_FEED_JS)
        banner = js.split("const sandboxBanner", 1)[1].split("\n", 1)[0]
        self.assertIn("try delete, snooze", banner)
        self.assertNotRegex(source(ROOT / "README.md"), r"(?i)\bdismiss")


def css_rules(css: str) -> list[tuple[str, list[str], dict[str, str]]]:
    """(media query or '', selectors, declarations) for every rule in `css`,
    in source order. Enough of a parser for the shell's minified styles."""
    rules, media, pos = [], [], 0
    rule_ends = set()  # a rule's own "}" must not close the media block around it
    for match in re.finditer(r"([^{}]*)\{|\}", css):
        if match.group(0) == "}":
            if match.start() in rule_ends:
                continue
            if media and media[-1][1] == "block":
                media.pop()
            continue
        prelude = match.group(1).strip()
        if prelude.startswith("@"):
            media.append((prelude, "block"))
            continue
        end = css.index("}", match.end())
        rule_ends.add(end)
        body = css[match.end():end]
        decls = {}
        for decl in body.split(";"):
            if ":" in decl:
                name, value = decl.split(":", 1)
                decls[name.strip()] = value.strip()
        selectors = [s.strip() for s in prelude.split(",")]
        rules.append((media[-1][0] if media else "", selectors, decls))
    return rules


def shell_css() -> str:
    return "".join(re.findall(r"<style>(.*?)</style>", source(VAULT_INDEX), re.S))


def base_rule(selector: str) -> dict[str, str]:
    """Merged declarations of every media-free rule naming `selector`."""
    merged = {}
    for media, selectors, decls in css_rules(shell_css()):
        if not media and selector in selectors:
            merged.update(decls)
    return merged


HEADER_PILLS = (".cardle-streak", ".cardle-account-id", ".cardle-api-tokens-btn",
                ".cardle-install-btn", ".cardle-signout-btn")


class HeaderAndSampleBannerTests(unittest.TestCase):
    """The starter-feed banner lines up with the feed, and the header's
    controls share one pill style and one accent colour."""

    def test_sample_banner_is_as_wide_as_the_feed_column_and_centred(self):
        feed = re.search(r"\.aurora-main\{max-width:(\d+)px;[^}]*padding:\d+px (\d+)px\}", source(AURORA_FEED_CSS))
        column = int(feed.group(1)) - 2 * int(feed.group(2))
        banner = base_rule(".cardle-sample-banner")
        self.assertEqual(banner.get("max-width"), f"{column}px")
        self.assertRegex(banner.get("margin", ""), r"^0 auto \d+px$")

    def test_sample_banner_clears_the_feeds_negative_top_margin(self):
        # .aurora-feed pulls itself up 16px (margin:-16px) to cancel .main's
        # padding; a smaller gap under the banner lets the feed cover its border.
        banner = base_rule(".cardle-sample-banner")
        bottom = int(re.search(r"(\d+)px$", banner.get("margin", "")).group(1))
        self.assertGreaterEqual(bottom, 16)
        self.assertEqual(banner.get("position"), "relative")

    def test_sample_banner_follows_the_feeds_narrow_gutter(self):
        # At <=640px the shell and feed both use a 12px gutter, so neither the
        # banner nor the feed needs to bleed outside the viewport.
        narrow = [decls for media, selectors, decls in css_rules(shell_css())
                  if media == "@media(max-width:640px)" and ".cardle-sample-banner" in selectors]
        self.assertTrue(narrow)
        self.assertEqual(narrow[-1].get("margin"), "0 0 16px")
        # At <=800px the feed's side padding drops to 16px, so its column is 760 - 32.
        feed = re.search(r"@media\(max-width:800px\)\{[^@]*?\.aurora-main\{padding:\d+px (\d+)px\}", source(AURORA_FEED_CSS))
        tablet = [decls for media, selectors, decls in css_rules(shell_css())
                  if media == "@media(max-width:800px)" and ".cardle-sample-banner" in selectors]
        self.assertEqual(tablet[-1].get("max-width"), f"{760 - 2 * int(feed.group(1))}px")
        self.assertEqual(base_rule(".cardle-sample-banner").get("box-sizing"), "border-box")

    def test_header_controls_share_one_pill_rule(self):
        shared = [decls for media, selectors, decls in css_rules(shell_css())
                  if not media and all(pill in selectors for pill in HEADER_PILLS)]
        self.assertEqual(len(shared), 1, "one media-free rule should style every header pill")
        for prop in ("height", "border", "border-radius", "background", "font-size", "font-weight", "color"):
            self.assertIn(prop, shared[0])
        self.assertEqual(shared[0]["border-radius"], "var(--radius-chip)")
        self.assertEqual(shared[0]["border"], "1px solid var(--border)")
        # No pill re-declares the template's size, shape or surface.
        for pill in HEADER_PILLS:
            for media, selectors, decls in css_rules(shell_css()):
                if not media and pill in selectors and len(selectors) == 1:
                    for prop in ("height", "border", "border-radius", "background", "font-size", "font-weight"):
                        self.assertNotIn(prop, decls, f"{pill} overrides the shared {prop}")
        js = source(VAULT_JS)
        self.assertIn('<span class="cardle-account-id">', js)

    def test_header_uses_aurora_tokens_with_a_single_accent(self):
        css = shell_css()
        for stray in ("#ff8a00", "#fff4e6", "#8a5a1f", "#2651b8", "#f5f8ff", "#dbe6fb", "#b9cdf7", "#1a3f94"):
            self.assertFalse(stray in css, f"{stray} is still in the shell styles")
        self.assertEqual(base_rule(".cardle-streak b").get("color"), "var(--accent-2)")
        self.assertEqual(base_rule(".cardle-api-tokens-btn").get("color"), "var(--accent-2)")

    def test_wordmark_is_just_the_name(self):
        # The small "CL" after "Cardlake" meant nothing to people, so it went.
        self.assertIn('<span class="cardle-wordmark">Cardlake</span>', source(VAULT_INDEX))
        self.assertNotIn("<small>CL</small>", source(VAULT_INDEX))

    def test_header_items_never_squeeze_into_each_other(self):
        # On a ~460px phone "About & help" wrapped onto the wordmark and Sign
        # out ran off-screen. Items keep their size (only the account name may
        # shrink); narrow screens swap labels for "Help" and icons instead.
        self.assertEqual(base_rule(".app-hdr>*").get("flex-shrink"), "0")
        self.assertEqual(base_rule(".cardle-info-trigger").get("white-space"), "nowrap")
        self.assertIn("@media(max-width:760px){.cardle-signout-btn svg{display:block}"
                      ".cardle-signout-btn span{display:none}}", shell_css())
        # With its label hidden, the icon-only Sign out button still has a name.
        self.assertIn('class="cardle-signout-btn" aria-label="Sign out"', source(VAULT_JS))

    def test_install_offer_is_a_header_icon_not_a_banner(self):
        # A banner above the feed would push the first card down on every
        # visit, so the install offer is one icon among the header's, hidden
        # until install.js finds the browser can install Cardlake.
        index = source(VAULT_INDEX)
        self.assertIn('class="cardle-install-btn" data-cardle-install data-cardle-install-button data-cardle-install-show="about" hidden aria-label="Install the Cardlake web app"', index)
        self.assertIn(".cardle-install-btn[hidden]", shell_css())
        self.assertIn("@media(max-width:760px){.cardle-install-btn svg{display:block}.cardle-install-btn span{display:none}}", shell_css())

    def test_link_covers_fall_back_where_container_units_are_missing(self):
        # Covers are laid out in cqw/cqh. iPadOS 15 drops those, which piled
        # each cover's labels into its top-left corner, so browsers without
        # them (or without oklch) get the plain pixel-laid-out cover.
        covers = source(ROOT / "public" / "vault" / "assets" / "covers.js")
        self.assertIn("CSS.supports('width', '1cqw') && CSS.supports('color', 'oklch(50% .1 260)')", covers)
        self.assertIn("coverHtml: drawable ? coverHtml : null", covers)
        self.assertIn("const covers = window.CardleCovers?.coverHtml ? window.CardleCovers : null;", source(AURORA_FEED_JS))

    def test_install_on_ios_names_the_browser_and_answers_every_tap(self):
        # iOS has no install prompt, so the button shows Add to Home Screen
        # steps. Those were Safari-only and, once showing, a second tap did
        # nothing visible -- which read as a broken button in Chrome on iPad.
        install = source(ROOT / "public" / "install.js")
        self.assertIn("/CriOS/.test(ua)", install)
        self.assertIn("next to the address bar", install)
        self.assertIn("classList.add('cardle-install-flash')", install)
        self.assertIn("<span data-cardle-install-ios-how>", source(VAULT_INDEX))
        self.assertIn(".cardle-install-flash{", source(VAULT_INDEX))


def run_node(script: str):
    # Node writes UTF-8 whatever the platform; Windows would otherwise decode it as cp1252.
    result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=60)
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


def js_block(js: str, start: str, end: str) -> str:
    """The source from `start` up to (not including) `end`."""
    head, found, rest = js.partition(start)
    if not found:
        raise AssertionError(f"{start!r} not found")
    return start + rest.split(end, 1)[0]


class UxFixesTests(unittest.TestCase):
    """Reported UX defects: the New card form, the Favorites count, the
    Connect AI dialog, the greeting, and GitHub issue cards' remove action."""

    def test_mobile_feed_uses_the_shell_gutter_without_page_overflow(self):
        css = source(AURORA_FEED_CSS)
        self.assertIn("@media(max-width:768px){.aurora-feed{margin:-12px}}", css)
        self.assertIn("@media(max-width:640px){.aurora-feed{margin:-12px;overflow-x:clip}", css)
        self.assertIn(".aurora-feed-views{flex-wrap:wrap;overflow:visible;margin:0 0 13px;padding:0}", css)
        self.assertIn("@media(max-width:360px){.aurora-feed-header{flex-wrap:wrap}", css)

    def test_feed_cards_and_dialogs_work_from_the_keyboard(self):
        js = source(AURORA_FEED_JS)
        card = js_block(js, "function cardHtml(card, index) {", "\n  function shell")
        self.assertIn('tabindex="0" aria-label="Open ${esc(titleOf(card))}.', card)
        bind = js_block(js, "function bind(r) {", "\n  function observe")
        self.assertIn("el.addEventListener('keydown'", bind)
        self.assertIn("e.key === 'Enter' || e.key === ' '", bind)
        self.assertIn("detail(card);", bind)
        modal = js_block(js, "function modal(content, className, onClose) {", "\n  function openSearch")
        self.assertIn("dialog.setAttribute('aria-labelledby', heading.id)", modal)
        capture = js_block(js, "function capture(initialType, prefill = {}, onClose) {", "\n  // A link shared to the installed app")
        # Quick add takes the focus, unless a shared link already filled the form.
        self.assertIn("requestAnimationFrame(() => (quick && !prefilled ? quick : node.querySelector('[data-capture-fields]", capture)
        self.assertIn("?.focus()", capture)

    def test_media_preview_setting_is_explicit_and_visually_secondary(self):
        js = source(AURORA_FEED_JS)
        css = source(AURORA_FEED_CSS)
        self.assertIn("<span>Previews</span><b>${mediaEnabled ? 'On' : 'Off'}</b>", js)
        self.assertIn("aria-label=\"Turn media previews ${mediaEnabled ? 'off' : 'on'}\"", js)
        self.assertIn(".aurora-media-toggle.is-active{border-color:var(--accent-2);background:var(--surface-2)", css)

    def test_switching_card_type_keeps_shared_fields(self):
        js = source(AURORA_FEED_JS)
        helpers = js_block(js, "const CAPTURE_SHARED_FIELD", "\n  async function uploadAttachment")
        # A fake form: a reminder with a title and a due date, switched to Misc
        # (whose title is section_title), then to a bookmark.
        result = run_node(helpers + r"""
          const form = fields => ({ querySelectorAll: () => fields });
          const reminder = [{ name: 'title', value: 'Renew passport' }, { name: 'due_date', value: '2026-11-01' }];
          const typed = captureValues(form(reminder));
          const misc = [{ name: 'section_title', value: '' }, { name: 'content', value: '' }];
          restoreCaptureValues(form(misc), typed);
          Object.assign(typed, captureValues(form(misc)));
          const bookmark = [{ name: 'title', value: '' }, { name: 'url', value: '' }];
          restoreCaptureValues(form(bookmark), typed);
          process.stdout.write(JSON.stringify({ misc, bookmark }));
        """)
        self.assertEqual(result["misc"][0]["value"], "Renew passport")
        self.assertEqual(result["bookmark"][0]["value"], "Renew passport")
        self.assertEqual(result["bookmark"][1]["value"], "")
        # The form keeps what was typed (and a chosen file) across re-renders.
        refresh = js_block(js, "const refresh = (guessed = {}) => {", "\n    };")
        self.assertLess(refresh.index("captureValues(fields)"), refresh.index("innerHTML = captureFields(type)"))
        self.assertLess(refresh.index("innerHTML = captureFields(type)"), refresh.index("restoreCaptureValues(fields, typed)"))
        self.assertIn("replaceWith(keptAttachment)", refresh)

    def test_favorites_count_drops_when_a_liked_card_leaves_the_feed(self):
        js = source(AURORA_FEED_JS)
        remove = js_block(js, "function removeAfterFeedAction(", "\n  function bringBack")
        bring = js_block(js, "function bringBack(", "\n  function like(")
        # The server counts only cards in the feed; the client must follow it
        # immediately and undo the change if the action fails.
        self.assertIn("if (wasLiked) state.stats.liked_cards = Math.max(0, Number(state.stats.liked_cards || 0) - 1);", remove)
        self.assertIn("if (wasLiked) state.stats.liked_cards = Number(state.stats.liked_cards || 0) + 1;", remove)
        self.assertIn("if (wasLiked) state.stats.liked_cards = Number(state.stats.liked_cards || 0) + 1;", bring)
        self.assertIn("if (wasLiked) state.stats.liked_cards = Math.max(0, Number(state.stats.liked_cards || 0) - 1);", bring)
        sandbox = js_block(js, "function sandboxStats()", "\n  }")
        self.assertIn("liked_cards: active.filter(c => c.liked_at).length", sandbox)

    def test_connect_ai_dialog_is_accessible(self):
        js = source(VAULT_JS)
        modal = js_block(js, "function openApiTokensModal(", "\n  // A brand-new account goes through onboarding")
        self.assertIn('role="dialog" aria-modal="true" aria-labelledby="cardle-tokens-title"', modal)
        self.assertIn('<h3 id="cardle-tokens-title" tabindex="-1">', modal)
        self.assertIn('aria-label="Token label"', modal)
        # Focus moves into the dialog, stays there, and goes back to the button.
        self.assertIn("showView(view, view === 'pick' ? modal.querySelector('[data-pick=\"claude\"]') : firstControl(view));", modal)
        self.assertIn("event.key === 'Escape'", modal)
        self.assertIn("event.key !== 'Tab'", modal)
        self.assertIn("opener?.focus()", modal)
        for path in ("modal.onclick = e => { if (e.target === modal) close(); };",
                     "modal.querySelector('[data-close]').onclick = close;"):
            self.assertIn(path, modal)
        # Every way out goes through close(), which restores focus.
        self.assertNotIn("=> modal.remove()", modal)
        self.assertIn(".addEventListener('click', event => openApiTokensModal(event.currentTarget))", js)

    def test_greeting_follows_the_local_hour(self):
        js = source(AURORA_FEED_JS)
        greeting = js_block(js, "function greeting(hour)", "\n  }") + "\n  }"
        result = run_node(greeting + "\nprocess.stdout.write(JSON.stringify(Array.from({ length: 24 }, (_, h) => greeting(h))));")
        expected = ["Good evening"] * 5 + ["Good morning"] * 7 + ["Good afternoon"] * 5 + ["Good evening"] * 7
        self.assertEqual(result, expected)
        self.assertIn("greeting(new Date().getHours())", js)
        self.assertNotIn("'Good afternoon' : `", js)

    def test_github_issue_cards_say_remove_from_cardle(self):
        js = source(AURORA_FEED_JS)
        self.assertIn("const isGithubIssue = card => card.type === 'kanban' && card.metadata?.source === 'github';", js)
        action_block = js_block(js, "function actionButtonsHtml(card) {", "\n  function cardHtml")
        card_block = js_block(js, "function cardHtml(card, index) {", "\n  function shell")
        detail_block = js_block(js, "function detail(card) {", "\n  function captureFields")
        self.assertIn("isGithubIssue(card) ? 'Remove from Cardlake'", js)
        for block in (action_block, detail_block):
            self.assertIn('${dismissLabel(card)}</button>', block)
        self.assertIn("isGithubIssue(card) ? 'Remove ↙'", card_block)
        self.assertIn("swipe left to ${dismissLabel(card).toLowerCase()}", card_block)
        # It is still the same feed action.
        self.assertIn("removeAfterFeedAction(card, el, 'dismiss')", js)


class DealPinAndCaptureTests(unittest.TestCase):
    """The deal limit is visible, snoozed or deleted pins free their slot at
    once, and New card can fill in a Work checklist and a Learning link."""

    def test_deal_buttons_show_how_many_deals_are_left_today(self):
        js = source(AURORA_FEED_JS)
        helper = js_block(js, "function dealsLeftText(left)", "\n  }") + "\n  }"
        result = run_node(helper + "\nprocess.stdout.write(JSON.stringify([0, 1, 2, 3].map(dealsLeftText)));")
        self.assertEqual(result, ["No deals left today", "1 deal left today", "2 deals left today", "3 deals left today"])
        prompt_button = js_block(js, "function dealButtonHtml()", "\n  }")
        self.assertIn("dealsLeftText(surprise.dealsLeftToday)", prompt_button)
        header = js_block(js, "function headerDealHtml()", "\n  }")
        self.assertIn('<b class="aurora-deal-left" aria-hidden="true">${surprise.dealsLeftToday}</b>', header)
        self.assertIn("aria-label=\"Deal me 5 fresh cards (${left})\"", header)
        run = js_block(js, "async function runDeal(", "\n  function shell")
        self.assertIn("dealsLeftText(result.dealsLeftToday)", run)
        self.assertIn(".aurora-deal-left{", source(AURORA_FEED_CSS))

    def test_snoozing_or_deleting_a_pinned_card_frees_its_slot_at_once(self):
        js = source(AURORA_FEED_JS)
        remove = js_block(js, "function removeAfterFeedAction(", "\n  function bringBack")
        self.assertIn("const wasPinned = !!card.pinned_at;", remove)
        self.assertIn("if (wasPinned) state.stats.pinned_cards = Math.max(0, pinnedCount() - 1);", remove)
        self.assertIn("if (wasPinned) state.stats.pinned_cards = pinnedCount() + 1;", remove)

    def test_new_work_card_takes_a_checklist(self):
        js = source(AURORA_FEED_JS)
        fields = js_block(js, "function captureFields(type)", "\n  ")
        self.assertIn('Checklist (one item per line)<textarea name="items_text"', fields)
        helper = js_block(js, "const checklistItems = ", "\n")
        typed = json.dumps("Draft\n  \n Review \r\nShip")  # a blank line and a Windows line ending
        result = run_node(helper + f"\nprocess.stdout.write(JSON.stringify(checklistItems({typed})));")
        self.assertEqual(result, [{"text": "Draft", "completed": False}, {"text": "Review", "completed": False}, {"text": "Ship", "completed": False}])
        self.assertIn("if (type === 'work') { values.items = checklistItems(values.items_text); delete values.items_text; }", js)
        self.assertNotIn("if (type === 'work') values.items = [];", js)

    def test_new_learning_card_takes_a_url_and_notes(self):
        js = source(AURORA_FEED_JS)
        fields = js_block(js, "function captureFields(type)", "\n  ")
        self.assertIn("type === 'learning' ?", fields)
        learning = fields.split("type === 'learning' ?", 1)[1].split(" : ''}", 1)[0]
        self.assertIn('URL (optional)<input name="url" type="url">', learning)
        self.assertIn('Notes (optional)<textarea name="notes"', learning)


class ThirdPartyLoadTests(unittest.TestCase):
    """Nothing sends a visitor's IP address to a third party before they
    act: sign-in is this site's own form, and the public demo shows no
    YouTube thumbnail."""

    def test_sign_in_loads_no_third_party_script(self):
        for path in (VAULT_JS, ROOT / "public" / "vault" / "assets" / "welcome.js", ROOT / "public" / "signin.html",
                     ROOT / "public" / "setup.html", ROOT / "api" / "oauth.js"):
            text = source(path)
            self.assertNotIn("gsi/client", text, path.name)
            self.assertNotRegex(text, r"<script[^>]+src=\"https?://", path.name)

    def test_demo_feed_shows_no_youtube_thumbnail(self):
        js = source(AURORA_FEED_JS)
        self.assertIn("const thumbnail = SANDBOX ? '' : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;", js)
        self.assertIn("${thumbnail ? `<img src=\"${thumbnail}\"", js)


if __name__ == "__main__":
    unittest.main()


COVERS_JS = ROOT / "public" / "vault" / "assets" / "covers.js"


class GeneratedCoverTests(unittest.TestCase):
    """With previews on, links get a cover drawn from the card itself
    (covers.js): Signal for video files, Editorial for articles, Postcard for
    bookmarks. YouTube links and images keep their real picture, and Cardlake's
    own uploaded files keep the plain cover."""

    def media_html(self, cards, sandbox=False):
        js = source(AURORA_FEED_JS)
        block = js_block(js, "const IMAGE_URL_EXTENSION", "\n  function mediaIndicatorHtml")
        return run_node(
            "global.window = { location: { origin: 'https://cardlake.example' } };\n"
            # A browser that can lay covers out (covers.js checks for cqw).
            + "global.CSS = { supports: () => true };\n"
            + source(COVERS_JS)
            + f"\nconst SANDBOX = {'true' if sandbox else 'false'}; const MEDIA_VISUALS_STORAGE_KEY = 'm';\n"
            + "const esc = s => String(s).replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n"
            + block
            + f"\nconsole.log(JSON.stringify({json.dumps(cards)}.map(mediaHtml)));"
        )

    def test_each_kind_of_link_gets_its_own_cover(self):
        when = "2026-09-11T10:00:00Z"
        youtube, article, bookmark, video_file, uploaded_video, image, pdf = self.media_html([
            {"id": "1", "type": "learning", "title": "A talk", "created_at": when, "metadata": {"url": "https://www.youtube.com/watch?v=HD8NPXRNPUO"}},
            {"id": "2", "type": "learning", "title": "Default hard budget caps", "created_at": when, "metadata": {"url": "https://simonwillison.net/2026/Oct/3/caps/"}},
            {"id": "3", "type": "bookmark", "title": "How complex systems fail", "created_at": when, "metadata": {"url": "https://how.complexsystems.fail/"}},
            {"id": "4", "type": "learning", "title": "A clip", "created_at": when, "metadata": {"url": "https://example.test/clip.mp4"}},
            {"id": "5", "type": "work", "title": "Demo", "created_at": when, "metadata": {"attachments": [{"url": "/api/feed?attachment_id=9", "mime_type": "video/mp4", "name": "demo.mp4"}]}},
            {"id": "6", "type": "bookmark", "title": "A photo", "created_at": when, "metadata": {"url": "https://example.test/photo.jpg"}},
            {"id": "7", "type": "file", "title": "notes.pdf", "created_at": when, "metadata": {"blob_url": "/api/feed?file_id=7", "mime_type": "application/pdf"}},
        ])
        self.assertIn("i.ytimg.com/vi/HD8NPXRNPUO/hqdefault.jpg", youtube)
        self.assertNotIn("cardle-cover", youtube)
        self.assertIn("cardle-cover cc-article", article)
        self.assertIn("From simonwillison.net", article)
        self.assertIn("cardle-cover cc-bookmark", bookmark)
        self.assertIn("HOW.COMPLEXSYSTEMS.FAIL / SAVED /", bookmark)
        self.assertIn("cardle-cover cc-video", video_file)
        self.assertIn("cardle-cover cc-video", uploaded_video)
        self.assertIn("Uploaded video", uploaded_video)
        self.assertIn("aurora-media-image", image)
        self.assertIn('<img src="https://example.test/photo.jpg"', image)
        self.assertIn("aurora-media-link", pdf)
        self.assertNotIn("cardle-cover", pdf)
        # A generated cover loads nothing: no image, and only the link itself.
        for cover in (article, bookmark, video_file, uploaded_video):
            self.assertNotIn("<img", cover)
            self.assertNotIn("src=", cover)

    def test_the_demo_draws_its_video_cover_instead_of_loading_youtube(self):
        (cover,) = self.media_html([{"id": "1", "type": "learning", "title": "A talk", "metadata": {"url": "https://youtu.be/HD8NPXRNPUO"}}], sandbox=True)
        self.assertIn("cardle-cover cc-video", cover)
        self.assertNotIn("ytimg", cover)

    def test_covers_are_repeatable_and_escape_the_title(self):
        card = {"id": "1", "type": "learning", "title": '<script>alert("x")</script> Systems', "metadata": {"url": "https://example.test/a"}}
        first, second = self.media_html([card, card])
        self.assertEqual(first, second)
        self.assertNotIn("<script>", first)

    def test_covers_load_before_the_feed_on_both_pages(self):
        for page in (VAULT_INDEX, SANDBOX_HTML):
            html = source(page)
            self.assertIn("/vault/assets/covers.css", html)
            self.assertLess(html.index("/vault/assets/covers.js"), html.index("/vault/assets/aurora-feed.js"))


class LinkTitleTests(unittest.TestCase):
    """A card whose whole title is a link, such as a reminder saved by pasting
    a YouTube URL, is shown as a link card with a readable title. Only the
    display changes."""

    def render(self, cards):
        js = source(AURORA_FEED_JS)
        block = js_block(js, "const IMAGE_URL_EXTENSION", "\n  function mediaIndicatorHtml")
        return run_node(
            "global.window = { location: { origin: 'https://cardlake.example' } };\n"
            # A browser that can lay covers out (covers.js checks for cqw).
            + "global.CSS = { supports: () => true };\n"
            + source(COVERS_JS)
            + "\nconst SANDBOX = false; const MEDIA_VISUALS_STORAGE_KEY = 'm';\n"
            + "const esc = s => String(s).replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n"
            + block
            + f"\nconsole.log(JSON.stringify({json.dumps(cards)}.map(c => [titleOf(c), mediaHtml(c)])));"
        )

    def test_a_bare_link_title_becomes_a_link_card(self):
        youtube, other, mixed, normal = self.render([
            {"id": "1", "type": "reminder", "title": "https://youtu.be/ekK8urKHPMQ?si=8D0yfOXx", "metadata": {}},
            {"id": "2", "type": "talking_point", "title": "  https://www.example.test/post  ", "metadata": {}},
            {"id": "3", "type": "reminder", "title": "Watch this https://youtu.be/ekK8urKHPMQ", "metadata": {}},
            {"id": "4", "type": "reminder", "title": "Build app to maximize Keepa", "metadata": {}},
        ])
        self.assertEqual(youtube[0], "YouTube video")
        self.assertIn("i.ytimg.com/vi/ekK8urKHPMQ/hqdefault.jpg", youtube[1])
        self.assertEqual(other[0], "Link from example.test")
        self.assertIn("cardle-cover cc-article", other[1])
        # Real text is never hidden, and a card without a link gets no picture.
        self.assertEqual(mixed, ["Watch this https://youtu.be/ekK8urKHPMQ", ""])
        self.assertEqual(normal, ["Build app to maximize Keepa", ""])

    def test_unsafe_links_in_titles_stay_plain_text(self):
        (card,) = self.render([{"id": "1", "type": "reminder", "title": "https://user:pass@example.test/x", "metadata": {}}])
        self.assertEqual(card, ["https://user:pass@example.test/x", ""])

    def test_every_title_the_feed_shows_goes_through_titleOf(self):
        js = source(AURORA_FEED_JS)
        self.assertNotIn("esc(card.title)", js)
        self.assertIn("<h3>${esc(titleOf(card))}</h3>", js)
        # Search still matches the stored title, link included.
        self.assertIn("card.title, card.subtitle, card.body", js)


class CardStateTests(unittest.TestCase):
    """Option A: motion that carries information. A reminder's ring drains
    toward its due time and turns urgent once due today; a work checklist's
    bar fills; a GitHub issue shows its status; cards without a link get a
    pattern for their type while previews are on."""

    def run_state(self, expression):
        js = source(AURORA_FEED_JS)
        block = js_block(js, "const GITHUB_STATUS", "\n  // GitHub issue cards carry")
        return run_node(
            "const DAY_MS = 864e5; const esc = s => String(s).replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n"
            + block + f"\nconsole.log(JSON.stringify({expression}));"
        )

    def test_reminder_ring_drains_and_turns_urgent_when_due(self):
        result = self.run_state("""(() => {
          const day = 864e5, now = Date.now(), iso = t => new Date(t).toISOString();
          const card = (due, extra = {}) => ({ type: 'reminder', created_at: iso(now - 4 * day), metadata: { due_date: due, ...extra } });
          const today = localDateKey(new Date(now));
          return {
            halfway: reminderTiming(card(iso(now + 4 * day))),
            overdue: reminderTiming(card(iso(now - day))),
            dueToday: reminderTiming(card(`${today}T00:00:00.000Z`)).urgent,
            nextYear: reminderTiming(card(`${new Date(now).getFullYear() + 1}-01-01T00:00:00.000Z`)).urgent,
            noDate: reminderTiming(card(null)),
            done: reminderTiming(card(iso(now + day), { completed: true })),
            notReminder: reminderTiming({ type: 'work', metadata: { due_date: iso(now) } }),
            ring: reminderRingHtml({ left: .25, urgent: false })
          };
        })()""")
        self.assertAlmostEqual(result["halfway"]["left"], .5, places=2)
        self.assertFalse(result["halfway"]["urgent"])
        self.assertEqual(result["overdue"], {"left": 0, "urgent": True})
        self.assertTrue(result["dueToday"])
        self.assertFalse(result["nextYear"])
        self.assertIsNone(result["noDate"])
        self.assertIsNone(result["done"])
        self.assertIsNone(result["notReminder"])
        self.assertIn('style="--off:75"', result["ring"])
        self.assertIn('aria-hidden="true"', result["ring"])

    def test_work_progress_has_a_readable_label(self):
        bar, empty, other = self.run_state("""[
          workProgressHtml({ type: 'work', metadata: { done: 3, total: 5 } }),
          workProgressHtml({ type: 'work', metadata: { done: 0, total: 0 } }),
          workProgressHtml({ type: 'reminder', metadata: { done: 1, total: 2 } })
        ]""")
        self.assertIn('role="img" aria-label="3 of 5 done"', bar)
        self.assertIn("--p:0.600", bar)
        self.assertEqual(empty, "")
        self.assertEqual(other, "")

    def test_cards_wire_in_state_and_patterns(self):
        js = source(AURORA_FEED_JS)
        card = js_block(js, "function cardHtml(card, index) {", "\n  function pinnedSectionHtml")
        self.assertIn('data-cc-key="${esc(cardKey(card))}"', card)
        self.assertIn("${timing?.urgent ? ' cs-urgent' : ''}", card)
        self.assertIn("${reminderRingHtml(timing)}", card)
        self.assertIn("${workProgressHtml(card)}", card)
        # Patterns are decoration: only behind cards with no link, only with previews on.
        self.assertIn("const pattern = mediaEnabled && !media && window.CardleCovers ? window.CardleCovers.patternHtml(card.type) : ''", card)
        meta = js_block(js, "function issueMetaHtml(card) {", "\n  const review")
        self.assertIn('<span class="cs-status cs-status-${esc(card.metadata.status)}">', meta)
        trial = js_block(js, "function trialHtml(card) {", "\n  async function loadSurprise")
        self.assertIn('<i class="cs-life" aria-hidden="true">', trial)
        self.assertIn('class="aurora-card-trial"', trial)

    def test_every_loop_pauses_off_screen_and_motion_can_be_turned_off(self):
        css = source(ROOT / "public" / "vault" / "assets" / "covers.css")
        for loop in ("csHalo", "csBeacon", "csRipple", "csSpin", "csCommit", "csCell"):
            self.assertRegex(css, rf"animation:{loop} [^;}}]*infinite paused", loop)
        self.assertIn(".cs-urgent.cc-visible .aurora-type-badge::after{animation-play-state:running}", css)
        self.assertIn("@media(prefers-reduced-motion:reduce)", css)
        self.assertIn('.aurora-feed-card [class*="cs-"]', css)


def feed_rule(selector: str, media: str = "") -> dict[str, str]:
    """Merged declarations of every aurora-feed.css rule naming `selector`
    under exactly `media` ('' for rules outside any media query)."""
    css = re.sub(r"/\*.*?\*/", "", source(AURORA_FEED_CSS), flags=re.S)
    merged = {}
    for rule_media, selectors, decls in css_rules(css):
        if rule_media == media and selector in selectors:
            merged.update(decls)
    return merged


class StickyFeedControlsTests(unittest.TestCase):
    """The feed's controls used to scroll away with the cards, leaving only
    the site header; filtering or adding a card meant scrolling back up."""

    def test_feed_controls_render_together_ahead_of_notices_and_cards(self):
        shell = js_block(source(AURORA_FEED_JS), "function shell() {", "\n  function integrationChipsHtml")
        template = shell.rsplit("return `", 1)[1]
        self.assertIn('<div class="aurora-feed-top">', template)
        top = template.split('<div class="aurora-feed-top">', 1)[1].split("${quotaNotice}", 1)[0]
        for part in ('<header class="aurora-feed-header">', '<div class="aurora-chips"', "${views}", "${progressBlock}"):
            self.assertIn(part, top)
        self.assertTrue(top.endswith("</div>"), "the sticky block closes before the notices")
        self.assertLess(template.index("${quotaNotice}"), template.index('<div class="aurora-list">'))

    def test_feed_controls_stick_under_the_app_header(self):
        rule = feed_rule(".aurora-feed-top")
        self.assertEqual(rule.get("position"), "sticky")
        # .app-hdr is 56px tall and sticky at top:0 with z-index 100.
        self.assertEqual(rule.get("top"), "56px")
        self.assertEqual(rule.get("background"), "var(--bg)")
        # Otherwise the progress label's bottom margin collapses out of the
        # block and cards scroll into view right against the label.
        self.assertEqual(rule.get("display"), "flow-root")
        self.assertTrue(0 < int(rule.get("z-index", "0")) < 100)

    def test_sandbox_feed_controls_stick_to_the_top(self):
        # The landing page's demo iframe has no app header above the feed.
        self.assertEqual(feed_rule(".demo-wrap .aurora-feed-top").get("top"), "0")

    def test_mobile_feed_clips_overflow_without_breaking_sticky(self):
        # overflow-x:hidden makes .aurora-feed a scroll container, so the
        # controls would stick to it rather than the viewport -- i.e. not at all.
        self.assertEqual(feed_rule(".aurora-feed", "@media(max-width:640px)").get("overflow-x"), "clip")

    def test_phone_feed_controls_scroll_with_the_cards(self):
        # Pinned on a phone, the controls took half the screen and only the
        # cards below them scrolled.
        rule = feed_rule(".aurora-feed-top", "@media(max-width:640px),(max-height:600px)")
        self.assertEqual(rule.get("position"), "static")

    def test_phone_view_controls_share_one_row(self):
        # They wrapped onto two rows on a phone, adding to the controls' height.
        views = feed_rule(".aurora-feed-views", "@media(max-width:640px)")
        self.assertEqual(views.get("flex-wrap"), "nowrap")
        self.assertEqual(views.get("overflow-x"), "auto")
        self.assertEqual(feed_rule(".aurora-sort-label", "@media(max-width:640px)").get("display"), "none")
        # A slimmer row, kept clear of the chips row's scrollbar above it.
        self.assertEqual(feed_rule(".aurora-view-toggle", "@media(max-width:640px)").get("min-height"), "36px")
        self.assertEqual(feed_rule(".aurora-chips", "@media(max-width:640px)").get("margin-bottom"), "10px")
        # The hidden words still name the Favorites and Snoozed buttons.
        hidden = feed_rule(".aurora-view-toggle:not(.aurora-media-toggle) span:not([aria-hidden])", "@media(max-width:640px)")
        self.assertEqual(hidden.get("position"), "absolute")
        self.assertNotEqual(hidden.get("display"), "none")

    def test_changing_filter_or_view_starts_the_new_list_from_the_top(self):
        js = source(AURORA_FEED_JS)
        helper = js_block(js, "function showListFromTop() {", "\n")
        result = run_node(helper + r"""
const calls = [];
global.window = { scrollY: 0, scrollTo: o => calls.push(o) };
showListFromTop();
window.scrollY = 2400;
showListFromTop();
process.stdout.write(JSON.stringify(calls));""")
        self.assertEqual(result, [{"top": 0}])
        bind = js_block(js, "function bind(r) {", "\n  function observe")
        for control in ("[data-filter]", "[data-favorites-toggle]", "[data-recall-toggle]", "[data-back-to-feed]"):
            handler = bind.split(f"r.querySelectorAll('{control}')", 1)[1].split("\n", 1)[0]
            self.assertIn("showListFromTop(); load(false);", handler, control)

    def test_keyboard_focus_keeps_cards_clear_of_the_pinned_controls(self):
        # Without a scroll margin, tabbing to a card above the fold scrolls it
        # to the viewport top -- under the pinned controls, out of sight.
        self.assertEqual(feed_rule(".aurora-feed-card").get("scroll-margin-top"), "296px")
        # On phones the controls scroll away, so only the app header covers cards.
        self.assertEqual(feed_rule(".aurora-feed-card", "@media(max-width:640px),(max-height:600px)").get("scroll-margin-top"), "72px")


class HeaderButtonHeightTests(unittest.TestCase):
    """Above 640px the header's search, Deal me 5 and New card buttons each
    sized themselves from their own padding and font, so the search glyph's
    taller fallback font made it stand taller than its neighbours."""

    def test_header_buttons_share_one_fixed_height(self):
        rule = feed_rule(".aurora-header-actions>button")
        self.assertRegex(rule.get("height", ""), r"^\d+px$")
        self.assertEqual(rule.get("box-sizing"), "border-box")
        # A button already centres its content vertically. Making the labels
        # flex items instead drops the whitespace between "+" and "New card".
        self.assertNotIn("display", rule)

    def test_header_actions_are_a_centred_flex_row_at_every_width(self):
        row = feed_rule(".aurora-header-actions")
        self.assertEqual(row.get("display"), "flex")
        self.assertEqual(row.get("align-items"), "center")
        self.assertEqual(row.get("gap"), "7px")
        self.assertEqual(feed_rule(".aurora-header-actions>button").get("margin"), "0")
        # The gap spaces the buttons; a margin of their own would double it.
        for button in (".aurora-search", ".aurora-header-deal"):
            self.assertNotIn("margin-right", feed_rule(button), f"{button} still adds its own margin")

    def test_phone_header_buttons_keep_the_touch_minimum(self):
        phone = "@media(max-width:640px)"
        for button in (".aurora-search", ".aurora-new", ".aurora-header-deal"):
            self.assertEqual(feed_rule(button, phone).get("min-height"), "44px")

    def test_buttons_outside_the_header_keep_their_own_size(self):
        # .aurora-new is also the modal's submit button; the shared height is
        # scoped to the header so it doesn't squash or stretch those.
        for button in (".aurora-new", ".aurora-action", ".aurora-search"):
            self.assertNotIn("height", feed_rule(button))


class NewFeedEmptyStateTests(unittest.TestCase):
    """A new account that chose an empty feed has nothing to be "caught up"
    on. It's told how to start -- add a card, ask an assistant, or Deal me 5 --
    instead of "Come back tomorrow"."""

    def empty_state(self, stats, *, surprise=True, main_feed=True):
        js = source(AURORA_FEED_JS)
        block = js_block(js, "function emptyStateHtml() {", "\n  function render()")
        stubs = (
            f"const state = {{ query: '', view: 'active', favoritesOnly: false, stats: {json.dumps(stats)} }};\n"
            "const counts = () => ({ learning: state.stats.learning_entries || 0, reminder: state.stats.reminders || 0 });\n"
            f"const onMainFeed = () => {json.dumps(main_feed)}; const surpriseReady = () => {json.dumps(surprise)};\n"
            "const dealButtonHtml = () => '<button data-deal>'; const changeTopicsHtml = () => ''; const streak = () => 0;\n"
        )
        return run_node(stubs + block + "\nconsole.log(JSON.stringify(emptyStateHtml()));")

    def test_an_empty_vault_says_how_to_start_and_offers_the_deal(self):
        html = self.empty_state({"learning_entries": 0, "reminders": 0, "snoozed_count": 0})
        self.assertIn("<h3>Your feed is empty</h3>", html)
        self.assertNotIn("Come back tomorrow", html)
        self.assertIn("data-empty-capture", html)
        self.assertIn("Deal me 5", html)
        self.assertIn("<button data-deal>", html)

    def test_without_the_deal_it_still_offers_a_first_card(self):
        html = self.empty_state({}, surprise=False)
        self.assertIn("<h3>Your feed is empty</h3>", html)
        self.assertIn("data-empty-capture", html)
        self.assertNotIn("Deal me 5", html)

    def test_a_reviewed_or_snoozed_feed_is_still_all_caught_up(self):
        for stats in ({"learning_entries": 3, "snoozed_count": 0}, {"snoozed_count": 2}):
            html = self.empty_state(stats)
            self.assertIn("<h3>All caught up</h3>", html, stats)

    def test_filtered_views_keep_their_own_empty_state(self):
        html = self.empty_state({}, main_feed=False)
        self.assertNotIn("Your feed is empty", html)

    def test_the_new_card_button_is_wired(self):
        js = source(AURORA_FEED_JS)
        self.assertIn("r.querySelector('[data-empty-capture]')?.addEventListener('click', SANDBOX ? sandboxSignInGate : () => capture());", js)

    def test_onboarding_and_the_sample_banner_mention_the_deal(self):
        welcome = source(ROOT / "public" / "welcome.html")
        start_empty = re.search(r'<p class="start-empty">(.*?)</p>', welcome, re.S).group(1)
        self.assertIn("Deal me 5", start_empty)
        self.assertIn("Want more? Tap Deal me 5", source(VAULT_JS))


class SiteUxReviewTests(unittest.TestCase):
    """Fixes from a UX pass over the site and the signed-in feed."""

    def subtitle(self, card, now="2026-10-12T12:00:00Z", tz="Asia/Kolkata"):
        block = js_block(source(AURORA_FEED_JS), "function subtitleOf(card", "\n  function cardHtml")
        stubs = ("const pad2 = n => String(n).padStart(2, '0');\n"
                 "const localDateKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;\n")
        return run_node(f"process.env.TZ = {json.dumps(tz)};\n" + stubs + block
                        + f"\nprocess.stdout.write(JSON.stringify(subtitleOf({json.dumps(card)}, Date.parse({json.dumps(now)}))));")

    def reminder(self, due, **metadata):
        return {"type": "reminder", "subtitle": "Due (server label) UTC", "metadata": {"due_date": due, **metadata}}

    def test_a_passed_reminder_says_overdue_in_the_readers_own_time(self):
        # 08:09 UTC is 13:39 in India; the server's label said "08:09 UTC".
        text = self.subtitle(self.reminder("2026-09-22T08:09:00.000Z"))
        self.assertTrue(text.startswith("Overdue, was due "), text)
        self.assertIn("1:39", text)
        self.assertNotIn("UTC", text)

    def test_day_only_due_dates_compare_as_calendar_days(self):
        self.assertTrue(self.subtitle(self.reminder("2026-10-12T00:00:00.000Z")).startswith("Due "))
        self.assertTrue(self.subtitle(self.reminder("2026-10-11T00:00:00.000Z")).startswith("Overdue"))
        # A day shows no time and keeps its date, whatever the reader's zone.
        text = self.subtitle(self.reminder("2026-11-03T00:00:00.000Z"), tz="America/Los_Angeles")
        self.assertIn("3", text)
        self.assertNotIn(":", text)
        self.assertNotIn("2026", text, "the current year is implied")

    def test_completed_repeating_and_other_cards(self):
        done = self.subtitle(self.reminder("2026-09-22T08:09:00.000Z", completed=True))
        self.assertTrue(done.startswith("Due "), done)
        weekly = self.subtitle(self.reminder("2026-10-20T00:00:00.000Z", recurrence="weekly"))
        self.assertTrue(weekly.endswith(", repeats weekly"), weekly)
        self.assertEqual(self.subtitle({"type": "learning", "subtitle": "en.wikipedia.org", "metadata": {}}), "en.wikipedia.org")
        self.assertEqual(self.subtitle({"type": "reminder", "subtitle": "No due date", "metadata": {}}), "No due date")
        js = source(AURORA_FEED_JS)
        self.assertNotIn("card.subtitle ? ` · ${esc(card.subtitle)}`", js, "cards and the detail view use subtitleOf")
        self.assertEqual(js.count("subtitle = subtitleOf(card)"), 2)

    def test_pinned_controls_drop_the_duplicate_help_link_and_filler_hint(self):
        # The app header already has Feedback and About & help; the demo
        # has no app header, so it keeps the link.
        shell = js_block(source(AURORA_FEED_JS), "function shell() {", "\n  function integrationChipsHtml")
        self.assertIn("<h2>${headerTitle}</h2>${SANDBOX ? supportLinkHtml() : ''}</div>", shell)
        self.assertNotIn("Favorites and snoozed cards stay easy to find.", shell)
        self.assertIn("state.favoritesOnly ? 'Showing your liked cards' : '';", shell)
        # No dangling aria-describedby when there is no hint to point at.
        self.assertIn("${hint ? ' aria-describedby=\"aurora-favorites-hint\"' : ''}", shell)

    def test_search_reads_as_search(self):
        js = source(AURORA_FEED_JS)
        self.assertNotIn(">⌕<", js)
        self.assertIn('data-search aria-label="Search feed">${SEARCH_ICON}</button>', js)
        self.assertIn('data-clear-search aria-label="Clear feed search">${CLOSE_ICON}</button>', js)
        shell = js_block(js, "function shell() {", "\n  function integrationChipsHtml")
        self.assertIn("state.query ? 'Search results' : 'Your feed'", shell)
        # The query is the reader's own text, so it is escaped like any other.
        self.assertIn("`For “${esc(state.query)}”`", shell)

    def test_filter_chips_wrap_above_phone_width(self):
        css = re.sub(r"/\*.*?\*/", "", source(INTEGRATIONS_CSS), flags=re.S)
        desktop = {}
        for media, selectors, decls in css_rules(css):
            if media == "@media(min-width:641px)" and ".aurora-chips" in selectors:
                desktop.update(decls)
        self.assertEqual(desktop.get("flex-wrap"), "wrap")
        self.assertEqual(desktop.get("overflow"), "visible")
        # A phone keeps one sideways-scrolling row.
        self.assertEqual(feed_rule(".aurora-chips", "@media(max-width:640px)").get("scrollbar-width"), "none")

    def test_new_card_form_styles_every_field(self):
        select = feed_rule(".aurora-capture-label select")
        self.assertEqual(select.get("width"), "100%")
        self.assertEqual(select.get("background"), "var(--surface-2)")
        self.assertEqual(select.get("margin"), feed_rule(".aurora-capture-label input").get("margin"))
        hint = feed_rule(".aurora-capture-label small")
        self.assertEqual(hint.get("text-transform"), "none")
        self.assertEqual(hint.get("display"), "block")
        css = source(AURORA_FEED_CSS)
        self.assertGreater(css.index(".aurora-capture-label small{"), css.index(".aurora-modal small{"), "must come after the modal's micro-label rule")

    def test_deal_me_5_is_secondary_inside_the_new_card_form(self):
        deal = feed_rule(".aurora-capture-deal .aurora-deal")
        self.assertEqual(deal.get("background"), "var(--surface-2)")
        self.assertEqual(deal.get("box-shadow"), "none")

class SiteUxReviewRoundTwoTests(unittest.TestCase):
    """A second UX pass: the app's page routing, About & help, Connect AI and
    the help pages."""

    def run_tabs(self, hash_="", stored="about", clicks=(), back=False):
        wire = js_block(source(VAULT_JS), "function wireTabs() {", "\n  function simpleResource")
        script = r"""
const pages = ['overview', 'about', 'admin'].map(name => ({ id: `page-${name}`, active: false, classList: { toggle(c, on) { this.owner.active = on; } } }));
pages.forEach(p => { p.classList.owner = p; });
const listeners = {}, pushed = [], removed = [];
global.localStorage = { getItem: () => %(stored)s, setItem: () => { throw new Error('remembered the tab'); }, removeItem: k => removed.push(k) };
global.location = { hash: %(hash)s, pathname: '/vault/index.html', search: '' };
global.history = { pushState: (_s, _t, url) => { pushed.push(url); location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } };
global.window = { addEventListener: (type, fn) => { listeners[type] = fn; } };
global.document = {
  getElementById: id => pages.find(p => p.id === id) || null,
  querySelectorAll: sel => sel === '.page' ? pages : [],
  addEventListener: (type, fn) => { listeners['doc:' + type] = fn; },
};
%(wire)s
wireTabs();
listeners['doc:DOMContentLoaded']();
for (const name of %(clicks)s) window.showPage(name);
if (%(back)s) { location.hash = ''; listeners.popstate(); }
process.stdout.write(JSON.stringify({ active: pages.find(p => p.active).id, pushed, removed }));
""" % {"stored": json.dumps(stored), "hash": json.dumps(hash_), "wire": wire,
       "clicks": json.dumps(list(clicks)), "back": json.dumps(back)}
        return run_node(script)

    def test_the_app_opens_on_the_feed_even_after_visiting_about(self):
        result = self.run_tabs(stored="about")
        self.assertEqual(result["active"], "page-overview")
        self.assertEqual(result["pushed"], [], "opening the app doesn't add a history entry")
        self.assertEqual(result["removed"], ["cardle-tab"], "the stale remembered tab is cleared")

    def test_pages_live_in_the_address_so_reload_and_back_work(self):
        self.assertEqual(self.run_tabs(hash_="#about")["active"], "page-about")
        clicked = self.run_tabs(clicks=["about"])
        self.assertEqual(clicked["pushed"], ["/vault/index.html#about"])
        self.assertEqual(clicked["active"], "page-about")
        self.assertEqual(self.run_tabs(clicks=["about"], back=True)["active"], "page-overview")
        home = self.run_tabs(hash_="#about", clicks=["overview"])
        self.assertEqual(home["pushed"], ["/vault/index.html"], "the feed is the bare address")

    def test_about_page_leads_back_to_the_feed_and_to_real_help(self):
        html = source(VAULT_INDEX)
        about = html.split('id="page-about">', 1)[1].split('<div class="page"', 1)[0]
        self.assertIn('<a class="cardle-info-back" href="#overview" onclick="return showPage(\'overview\')">&larr; Back to your feed</a>', about)
        self.assertNotIn('href="/feedback.html"', about)
        for href in ("/mcp-setup.html", "/support.html", "/privacy.html"):
            self.assertIn(f'href="{href}"', about)
        # The help names the feed's real actions, not "remind yourself later".
        self.assertNotIn("Swipe cards to remind yourself later or dismiss them", about)
        for action in ("<strong>Snooze</strong>", "<strong>Complete</strong>", "Pin up to three", "<strong>Deal me 5</strong>", "<strong>Connect AI</strong>"):
            self.assertIn(action, about)

    def test_about_page_uses_the_blue_brand_not_the_old_purple(self):
        for path in (VAULT_INDEX, ROOT / "public" / "vault" / "assets" / "learnings.css"):
            self.assertNotIn("#7559d9", source(path).lower(), path.name)

    def test_connect_ai_starts_with_a_choice_of_assistant(self):
        # Claude comes first, then ChatGPT and Gemini, then the small link for
        # tokens. All three assistants are added by this Cardlake's own address, shown with
        # their steps; nothing points at a directory listing.
        js = source(VAULT_JS)
        modal = js_block(js, "function openApiTokensModal(", "\n  // A brand-new account goes through onboarding")
        self.assertIn('<button type="button" class="cardle-connect-pick" data-pick="claude">', modal)
        self.assertLess(modal.index('data-pick="claude"'), modal.index('data-pick="chatgpt"'))
        self.assertLess(modal.index('data-pick="chatgpt"'), modal.index('data-pick="gemini"'))
        self.assertLess(modal.index('data-pick="gemini"'), modal.index('data-pick="token"'))
        self.assertIn("function openApiTokensModal(opener, view = 'pick') {", js)
        self.assertIn("<code data-server-address>${escapeHtml(SERVER_ADDRESS)}</code>", modal)
        self.assertIn('<div data-connect-view="claude" hidden>${addressHtml}', modal)
        self.assertIn('<div data-connect-view="chatgpt" hidden>${addressHtml}', modal)
        self.assertIn('<div data-connect-view="gemini" hidden>${addressHtml}', modal)
        self.assertNotIn("claude.ai/directory", modal)
        self.assertIn("modal.querySelectorAll('.cardle-token-address').forEach(row => wireCopy(row.querySelector('[data-copy-server]'), row.querySelector('[data-server-address]')));", modal)

    def test_connect_ai_steps_through_one_choice_and_watches_for_the_connection(self):
        js = source(VAULT_JS)
        modal = js_block(js, "function openApiTokensModal(", "\n  // A brand-new account goes through onboarding")
        markup = modal[modal.index("modal.innerHTML = `"):modal.index("document.body.appendChild(modal);")]
        view_names = ("pick", "claude", "chatgpt", "gemini", "token")
        start = modal.index("const showView = (view, focus) => {")
        functions = modal[start:modal.index("    showView(view, ", start)]
        script = r"""
          const assert = require('node:assert/strict');
          const vm = require('node:vm');
          const make = attrs => ({ hidden: false, dataset: {}, focused: 0, focus() { this.focused += 1; }, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, querySelector: () => null, ...attrs });
          const firsts = {};
          const views = Object.fromEntries(VIEWS.map(name => [name, make({ dataset: { connectView: name }, querySelector: () => (firsts[name] = firsts[name] || make({})) })]));
          const picks = ['claude', 'chatgpt', 'gemini', 'token'].map(name => make({ dataset: { pick: name } }));
          const back = make({}), progress = make({});
          const modal = {
            querySelectorAll: selector => (selector === '[data-connect-view]' ? Object.values(views) : selector === '[data-pick]' ? picks : []),
            querySelector: selector => ({ '[data-connect-progress]': progress, '[data-pick="claude"]': picks[0] })[selector]
              || views[(selector.match(/data-connect-view="(\w+)"/) || [])[1]],
          };
          const context = { modal, back };
          vm.createContext(context);
          vm.runInContext(FUNCTIONS + '; this.showView = showView;', context);
          const visible = () => VIEWS.filter(name => !views[name].hidden);
          context.showView('pick');
          assert.deepEqual(visible(), ['pick']);
          assert.equal(progress.hidden, true, 'no waiting status before a choice');
          assert.equal(back.hidden, true);
          picks[0].listeners.click();
          assert.deepEqual(visible(), ['claude'], 'clicking Claude shows the address and its steps');
          assert.equal(progress.hidden, false, 'Claude shows the waiting status');
          assert.equal(back.hidden, false);
          assert.equal(firsts.claude.focused, 1, 'focus lands on the Copy button');
          back.onclick();
          assert.deepEqual(visible(), ['pick']);
          assert.equal(picks[0].focused, 1);
          picks[1].listeners.click();
          assert.deepEqual(visible(), ['chatgpt']);
          assert.equal(progress.hidden, false);
          picks[2].listeners.click();
          assert.deepEqual(visible(), ['gemini'], 'Gemini is pasted in like ChatGPT');
          assert.equal(progress.hidden, false, 'Gemini shows the waiting status');
          picks[3].listeners.click();
          assert.deepEqual(visible(), ['token']);
          assert.equal(progress.hidden, true, 'tokens have nothing to wait for');
        """.replace("VIEWS", json.dumps(list(view_names))).replace("FUNCTIONS", json.dumps(functions))
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in view_names:
            self.assertIn(f'data-connect-view="{name}"', markup)
        self.assertNotIn("cardle-connect-tabs", markup)
        # The steps still come from connect-ai.js, so they can't drift from
        # the setup guide; example questions wait for the connection.
        self.assertIn("${stepsHtml('claude')}", markup)
        self.assertIn("${stepsHtml('chatgpt')}", markup)
        self.assertIn("${stepsHtml('gemini')}", markup)
        self.assertIn('<div data-connect-prompts hidden><h4>Now try asking</h4>', markup)
        self.assertLess(markup.index('data-connect-view="token" hidden'), markup.index('class="cardle-token-new"'))
        self.assertLess(markup.index('class="cardle-token-new"'), markup.index("Advanced: sync token"))
        self.assertIn("watchForAssistantConnection(modal);", modal)
        watch = js_block(js, "async function watchForAssistantConnection(modal) {", "\n  // opener gets focus back")
        self.assertIn("api('/api/onboarding')", watch)
        self.assertIn("modal.querySelector('[data-connect-prompts]').hidden = false;", watch)
        # Polling stops once the dialog closes.
        self.assertIn("whenAssistantConnects(modal, () => {", watch)
        self.assertIn("if (!element.isConnected || Date.now() > stopAt) return clearInterval(timer);", watch)

    def copy(self, clipboard_works):
        wire = js_block(source(VAULT_JS), "function wireCopy(button, code) {", "\n  // opener gets focus back")
        script = r"""
const selected = [];
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { if (!%s) throw new Error('blocked'); selected.push('clip:' + text); } } } });
global.document = { createRange: () => ({ selectNodeContents: node => selected.push('range:' + node.textContent) }) };
global.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
global.setTimeout = () => {};
%s
const button = { textContent: 'Copy', isConnected: true }, code = { textContent: 'https://cardlake.example/api/mcp' };
wireCopy(button, code);
button.onclick().then(() => process.stdout.write(JSON.stringify({ label: button.textContent, selected })));
""" % (json.dumps(clipboard_works), wire)
        return run_node(script)

    def test_copy_buttons_say_whether_they_worked(self):
        self.assertEqual(self.copy(True), {"label": "Copied", "selected": ["clip:https://cardlake.example/api/mcp"]})
        blocked = self.copy(False)
        self.assertEqual(blocked["label"], "Selected: copy it")
        self.assertEqual(blocked["selected"], ["range:https://cardlake.example/api/mcp"])
        modal = js_block(source(VAULT_JS), "function openApiTokensModal(", "\n  // A brand-new account goes through onboarding")
        self.assertNotIn("navigator.clipboard?.writeText", modal)

    def test_token_errors_show_in_the_dialog_not_an_alert(self):
        modal = js_block(source(VAULT_JS), "function openApiTokensModal(", "\n  // A brand-new account goes through onboarding")
        self.assertNotIn("alert(`", modal)
        self.assertIn('<p class="cardle-token-error" data-token-error role="alert"></p>', modal)
        self.assertIn("error.textContent = `Could not generate a token: ${err.message}`;", modal)

    def test_token_dates_spell_the_month(self):
        js = source(VAULT_JS)
        self.assertIn("const tokenDate = value => new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });", js)
        row = js_block(js, "function apiTokenRowHtml(token) {", "\n  }")
        self.assertNotIn(".toLocaleDateString()", row)

    def test_support_page_is_reachable_and_is_the_owners(self):
        self.assertIn('href="/support.html"', source(VAULT_INDEX))
        support = source(ROOT / "public" / "support.html")
        # Run by its owner for themselves: no company to write to, no form.
        self.assertNotIn("feedback.html", support)
        self.assertNotRegex(support, r"mailto:|@[a-z0-9-]+\.[a-z]")
        self.assertIn('href="/setup"', support)

    def test_the_setup_guide_says_feed_not_vault(self):
        guide = source(ROOT / "public" / "mcp-setup.html")
        self.assertNotRegex(guide, r"your (Cardlake )?vault")
