// The feed's sort orders. "ai" is the default: a small, explainable scoring
// model over a card's own fields (dates, status, likes). "newest" is plain
// date added, and doubles as the way to turn the AI order off.
//
// The model is deliberately simple so it can grow without being rewritten:
// each signal scores a card from 0 to 1, and a card's score is the weighted
// sum. Personalising it later means passing per-account `weights` (learned
// from user_events: what was served, then liked, snoozed or dismissed) or
// adding a signal -- not changing how cards are ranked. Learning from
// activity needs a notice and an off switch first (docs/AI_DATA_USE.md).

const SORTS = ['ai', 'newest'];
const DEFAULT_SORT = 'ai';
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_WEIGHTS = {
  urgency: 3,      // a reminder that's due or overdue beats everything else
  momentum: 1,     // work under way: an assigned issue, a half-done checklist, a card back from snooze
  liked: 0.8,      // the person said they care about it
  freshness: 1.2,  // just added
  rediscovery: 0.6, // old enough to have been forgotten
  daily: 0.4,      // a per-day shuffle, so the order changes from day to day
};

// Taken off a card's score when it would extend a run of its type, after
// 0, 1 or 2 cards of that type in a row: a second in a row costs a little,
// and a third never happens while another type is left -- not even for a
// pile of overdue reminders.
const SAME_TYPE_PENALTY = [0, 0.5, Infinity];

function resolveSort(value) {
  return SORTS.includes(value) ? value : DEFAULT_SORT;
}

const ageDays = (card, now) => Math.max(0, (now - new Date(card.created_at || 0).getTime()) / DAY_MS);

function urgency(card, now) {
  if (card.type !== 'reminder') return 0;
  if (!card.metadata?.due_date) return 0.1;
  const daysLeft = (new Date(card.metadata.due_date).getTime() - now) / DAY_MS;
  if (daysLeft < 0) return 1;
  if (daysLeft < 1) return 0.8;
  if (daysLeft < 3) return 0.5;
  if (daysLeft < 7) return 0.25;
  return 0;
}

function momentum(card, now) {
  if (card.type === 'kanban' && card.metadata?.status === 'in_progress') return 1;
  // A card whose snooze has ended was put off on purpose, for about now.
  if (card.remind_later_until && new Date(card.remind_later_until).getTime() <= now) return 0.7;
  const { done = 0, total = 0 } = card.type === 'work' ? card.metadata || {} : {};
  return total > 0 && done > 0 && done < total ? done / total : 0;
}

// A stable 0..1 value per card per day: the order holds while someone pages
// through the feed (pages are offsets into it) and changes tomorrow.
function dailyShuffle(card, day) {
  let hash = 2166136261;
  for (const char of `${day}:${card.type}:${card.id}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) / 2 ** 32;
}

function signals(card, now, day) {
  const age = ageDays(card, now);
  return {
    urgency: urgency(card, now),
    momentum: momentum(card, now),
    liked: card.liked_at ? 1 : 0,
    freshness: Math.exp(-age / 3),
    rediscovery: 1 - Math.exp(-age / 30),
    daily: dailyShuffle(card, day),
  };
}

function scoreCard(card, { now = Date.now(), weights = DEFAULT_WEIGHTS } = {}) {
  const values = signals(card, now, new Date(now).toISOString().slice(0, 10));
  return Object.entries(values).reduce((sum, [name, value]) => sum + (weights[name] || 0) * value, 0);
}

const byNewest = (a, b) => new Date(b.created_at) - new Date(a.created_at) || String(a.id).localeCompare(String(b.id));

// Best first, then mixed: each slot goes to the best card of whichever type
// scores highest once repeating the last card's type is penalised.
function rankByAi(cards, options) {
  const queues = new Map();
  for (const card of cards) {
    if (!queues.has(card.type)) queues.set(card.type, []);
    queues.get(card.type).push({ card, score: scoreCard(card, options) });
  }
  for (const queue of queues.values()) queue.sort((a, b) => b.score - a.score || byNewest(a.card, b.card));
  const result = [];
  while (result.length < cards.length) {
    const run = result.length ? result[result.length - 1].type : null;
    const runLength = run ? result.slice(-2).filter(card => card.type === run).length : 0;
    let bestQueue = null;
    let bestScore = -Infinity;
    for (const [type, queue] of queues) {
      if (!queue.length) continue;
      const adjusted = queue[0].score - (type === run ? SAME_TYPE_PENALTY[runLength] : 0);
      if (!bestQueue || adjusted > bestScore || (adjusted === bestScore && byNewest(queue[0].card, bestQueue[0].card) < 0)) { bestQueue = queue; bestScore = adjusted; }
    }
    result.push(bestQueue.shift().card);
  }
  return result;
}

function sortCards(cards, sort, options = {}) {
  return resolveSort(sort) === 'newest' ? [...cards].sort(byNewest) : rankByAi(cards, options);
}

module.exports = { SORTS, DEFAULT_SORT, DEFAULT_WEIGHTS, resolveSort, scoreCard, sortCards };
