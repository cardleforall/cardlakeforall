// Date math for recurring reminders. Everything is UTC so the result doesn't
// depend on the server's time zone; feed-created due dates are UTC midnight,
// so this is day-accurate for them.
const RECURRENCES = ['daily', 'weekly', 'monthly', 'yearly'];

function addMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  // Jan 31 + 1 month is Feb 28/29, not Mar 3.
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

// `steps` intervals after `date`, always counted from the original date so
// month-end clamping doesn't drift within a single roll-forward.
function addInterval(date, recurrence, steps) {
  const start = new Date(date);
  if (recurrence === 'daily') return new Date(start.getTime() + steps * 864e5);
  if (recurrence === 'weekly') return new Date(start.getTime() + steps * 7 * 864e5);
  if (recurrence === 'monthly') return addMonths(start, steps);
  if (recurrence === 'yearly') return addMonths(start, steps * 12);
  throw new Error(`Invalid recurrence: ${recurrence}`);
}

// The next occurrence after `now`. Missed occurrences are skipped rather than
// stacked.
function nextOccurrence({ due_date, recurrence }, now = new Date()) {
  if (!due_date) return { due_date: addInterval(now, recurrence, 1).toISOString() };
  let steps = 1;
  while (addInterval(due_date, recurrence, steps) <= now) steps += 1;
  return { due_date: addInterval(due_date, recurrence, steps).toISOString() };
}

module.exports = { RECURRENCES, addInterval, nextOccurrence };
