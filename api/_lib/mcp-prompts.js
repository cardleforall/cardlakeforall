const { z } = require('zod');

// Ready-made prompts: clients that support MCP prompts show these as commands
// (e.g. "/daily_review"). Each one is only instructions for the model -- the
// same for every account, never any account data -- and asks it to use the
// read tools, so a read-only OAuth grant gets them too. Changing a card stays
// the user's call: the prompts suggest, and act only when asked.
const PROMPTS = [
  {
    name: 'daily_review',
    title: 'Daily review',
    description: "Go through today's Cardlake feed: what's pinned, due and new, and a short plan for the day.",
    text: () => [
      "Help me review my Cardlake feed for today.",
      '1. Call list_feed (up to 50 cards) to see the active feed, with pinned cards first.',
      '2. Summarise it briefly: pinned cards, reminders due today or overdue (in my time zone), and anything new or unfinished that deserves attention.',
      '3. Suggest a short plan for the day: what to do, what could be snoozed, and what looks finished.',
      "Don't snooze, pin, complete or delete anything unless I ask you to.",
    ].join('\n'),
  },
  {
    name: 'weekly_recap',
    title: 'Weekly recap',
    description: 'Recap the past week in Cardlake: what was added and finished, by card type.',
    text: () => [
      'Give me a recap of my past week in Cardlake.',
      '1. Call get_dashboard_stats for totals by card type.',
      '2. Call list_feed (and search_cards where useful) to find cards created in the last 7 days, using each card\'s created_at, and cards that look finished (completed reminders, watched or skimmed learnings, closed GitHub issues, fully checked work items).',
      '3. Summarise by card type: what was added, what was finished, and anything that has been waiting a while.',
      'Keep it short, and don\'t change any cards.',
    ].join('\n'),
  },
  {
    name: 'find_card',
    title: 'Find a card',
    description: 'Find a card in Cardlake by what it is about, and show it in full.',
    args: { about: z.string().describe('What the card is about, e.g. "dentist" or "the React hooks article".') },
    text: ({ about }) => [
      `Find the Cardlake card about: ${about}`,
      '1. Call search_cards with the most distinctive words from that description. If nothing matches, try fewer or different words.',
      '2. Call get_card on the best match and show it to me in full.',
      "3. If several cards could be the one, list them briefly and ask which I meant. Don't change any cards.",
    ].join('\n'),
  },
];

function registerPrompts(server) {
  for (const prompt of PROMPTS) {
    server.registerPrompt(prompt.name, {
      title: prompt.title,
      description: prompt.description,
      ...(prompt.args ? { argsSchema: prompt.args } : {}),
    }, args => ({
      description: prompt.description,
      messages: [{ role: 'user', content: { type: 'text', text: prompt.text(args || {}) } }],
    }));
  }
}

module.exports = { registerPrompts, PROMPTS };
