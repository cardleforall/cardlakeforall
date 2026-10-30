// Starter feeds for the onboarding flow (public/welcome.html). Picking a
// persona gives a new account a full, realistic feed on day one instead of an
// empty page; api/_lib/onboarding.js writes these as ordinary cards the
// person can keep, edit or clear.
//
// Content rule: nothing here may read like someone else's life -- no names,
// weekdays, dates or one-off appointments (see test_onboarding.py). Reminders
// are one-time for now and fall due at the next `time` in the person's own
// time zone; `repeat` says how they would recur once recurring reminders exist.
// Family cards show `person` as their title, so it holds the card's headline.

const learning = (title, url, notes = '') => ({ type: 'learning', title, url, notes, category: 'ai' });
const bookmark = (title, url, notes = '', category = 'tech') => ({ type: 'bookmark', title, url, notes, category });
const reminder = (title, time, repeat) => ({ type: 'reminder', title, time, repeat });
const task = title => ({ type: 'reminder', title, time: null, repeat: null });
const talkingPoint = (title, content) => ({ type: 'talking_point', title, content });
const work = (title, items) => ({ type: 'work', title, items });
const family = (title, content = '') => ({ type: 'family', title, content });

const PERSONAS = [
  {
    id: 'agentic_exec',
    name: 'The Agentic Exec',
    tagline: 'Leads a team and is all-in on GenAI.',
    prompts: ["What's in my Cardlake feed today?", 'Summarize my AI learnings in three bullets', 'Snooze my focus-time reminder to tomorrow'],
    cards: [
      learning('How we build effective agents', 'https://www.youtube.com/watch?v=D7_ipDqhtwk', 'Anthropic on when you need an agent and when a workflow is enough.'),
      learning('What is MCP?', 'https://www.youtube.com/watch?v=eur8dUO9mvE', 'How AI assistants plug into your tools.'),
      learning('From vibe coding to agentic engineering', 'https://www.youtube.com/watch?v=96jN2OCOfLs', 'Andrej Karpathy with Sequoia. Watch on a weekend.'),
      learning('Software is changing (again)', 'https://www.youtube.com/watch?v=LCEmiRjPEtQ', 'Andrej Karpathy at Y Combinator.'),
      learning('Jevons paradox and the AI compute boom', 'https://en.wikipedia.org/wiki/Jevons_paradox', 'Cheaper inference tends to raise total demand. Worth rereading before budgeting.'),
      talkingPoint('Where is AI actually saving us time?', 'Ask each team for one measured win and one flop.'),
      talkingPoint('Our stance on AI and customer data', 'Agree on it before the next board discussion.'),
      work('AI roadmap for next quarter', ['Pick 3 pilots', 'Name an owner for each', 'Define success metrics', 'Review with finance']),
      bookmark('Claude prompt library', 'https://docs.claude.com/en/resources/prompt-library/library', 'Ready-made prompts to share with the team.'),
      reminder('Gym 7am', '07:00', 'daily'),
      reminder('Block 30 min of focus time', '09:00', 'daily'),
      reminder('Weekly review', '17:00', 'weekly'),
      family('Plan a family weekend outing', 'Something outdoors.'),
      family('Call home', 'Just to catch up.'),
    ],
  },
  {
    id: 'ai_builder',
    name: 'The AI Builder',
    tagline: 'Engineer shipping with agents and MCP.',
    prompts: ["What's in my Cardlake feed today?", 'Tick off "Define 3 tools" on my MCP server card', 'Which videos have I saved about evals?'],
    cards: [
      learning('AI evals clearly explained (50 min)', 'https://www.youtube.com/watch?v=uiza7wp1KrE', 'Start with 20 real examples, not 2,000 synthetic ones.'),
      learning('Tips for building AI agents', 'https://www.youtube.com/watch?v=LP5OCa20Zpg', 'From the Anthropic team.'),
      learning('Building agents with MCP (workshop)', 'https://www.youtube.com/watch?v=kQmXtrmQ5Zg', 'Transports, auth, tools and resources, end to end.'),
      learning('Prompt caching', 'https://docs.claude.com/en/docs/build-with-claude/prompt-caching', 'Cut the cost and latency of long, repeated context.'),
      learning('Writing effective tools for agents', 'https://www.anthropic.com/engineering/writing-tools-for-agents', 'Clear names and small inputs beat clever abstractions.'),
      work('Ship my first MCP server', ['Define 3 tools', 'Add auth', 'Write evals', 'Deploy']),
      work('Add an eval suite to CI', ['Choose 20 cases', 'Set a pass bar', 'Fail the build below it']),
      bookmark('Claude Code docs', 'https://docs.claude.com/en/docs/claude-code/overview', 'Commands, hooks and MCP setup.'),
      bookmark('Claude Code best practices', 'https://www.youtube.com/watch?v=gv0WHhKelSE', 'Anthropic talk.'),
      bookmark('Awesome MCP servers', 'https://github.com/punkpeye/awesome-mcp-servers', 'Existing servers to learn from.'),
      reminder('Gym 7am', '07:00', 'daily'),
      reminder('Stand up and stretch', '15:00', 'daily'),
      reminder('Back up your laptop', '18:00', 'weekly'),
      task('Plan the weekend'),
      task('Read before bed'),
    ],
  },
  {
    id: 'product_leader',
    name: 'The Product Leader',
    tagline: 'PM or design lead bringing AI into the product.',
    prompts: ["What's in my Cardlake feed today?", 'What should I bring up in my 1:1s?', 'Add a reminder to share the discovery one-pager'],
    cards: [
      learning('Designing UX for AI products', 'https://www.youtube.com/watch?v=69EokIgHjmU', 'How to show uncertainty, let people undo, and keep a human in control.'),
      learning('How AI is reshaping the product role', 'https://www.youtube.com/watch?v=e1R_-esuO9o', "Lenny's Podcast."),
      learning('Why AI evals are the hottest new skill for product builders', 'https://www.youtube.com/watch?v=BsWxPI9UM4c', "Lenny's Podcast. Define \"good\" with examples before anything is built."),
      talkingPoint("1:1: What's blocking you this week?", 'Listen first, then ask about solutions.'),
      talkingPoint('1:1: One AI experiment worth trying', 'Keep it small, time-boxed and measurable.'),
      work('Discovery sprint', ['5 customer calls', 'Synthesize themes', 'Pick 1 bet', 'Share a one-pager']),
      bookmark('Competitor AI feature teardown', null, 'Where they are ahead, and where we can be different.', 'business'),
      bookmark('The Shape of AI: UX patterns', 'https://www.shapeof.ai/', 'A library of interaction patterns for AI features.', 'business'),
      reminder('Morning walk', '07:30', 'daily'),
      reminder('Inbox zero before lunch', '12:00', 'daily'),
      reminder('Weekly review', '17:00', 'weekly'),
      family('Plan a family dinner', 'Everyone picks one dish.'),
      task("Call a friend you haven't spoken to in a while"),
      task('Try a new recipe'),
    ],
  },
  {
    id: 'curious_learner',
    name: 'The Curious Learner',
    tagline: 'Learning AI, maybe switching careers.',
    prompts: ["What's in my Cardlake feed today?", 'Which video should I watch first?', 'Mark the 3Blue1Brown video as watched'],
    cards: [
      learning('Intro to large language models (1 hr)', 'https://www.youtube.com/watch?v=zjkBMFhNj_g', 'Andrej Karpathy. A beginner-friendly overview.'),
      learning('Large language models explained briefly', 'https://www.youtube.com/watch?v=LPZh9BOjkQs', '3Blue1Brown.'),
      learning('Prompt engineering: a deep dive', 'https://www.youtube.com/watch?v=T9aRN5JkmL8', 'Be specific, show examples, and let the model think.'),
      learning('Introduction to generative AI', 'https://www.youtube.com/watch?v=cZaNf2rA30k', 'Google Cloud. Do one module a day.'),
      learning('What is MCP?', 'https://www.youtube.com/watch?v=eur8dUO9mvE', 'The plug that connects AI assistants to apps.'),
      work('Build a portfolio project', ['Pick a problem', 'Build an MVP', 'Write it up', 'Share it']),
      bookmark('Free AI short courses', 'https://www.deeplearning.ai/short-courses/', 'Sorted by level.'),
      talkingPoint('Questions for my next coffee chat', 'What surprised you about working in AI?'),
      reminder('Study block 8pm', '20:00', 'daily'),
      reminder('Drink water', '15:00', 'daily'),
      reminder('Weekly review', '17:00', 'weekly'),
      task('Plan the weekend'),
      task('Read 20 pages'),
      family('Call home', 'Just to catch up.'),
    ],
  },
];

const PERSONA_IDS = new Set(PERSONAS.map(persona => persona.id));

function findPersona(id) {
  return PERSONAS.find(persona => persona.id === id) || null;
}

// What the persona step shows: enough to choose, not the whole card list --
// one learning, one piece of work, one reminder, so the mix is visible.
const PREVIEW_PICKS = [['learning'], ['work', 'talking_point', 'bookmark'], ['reminder']];

function personaSummaries() {
  return PERSONAS.map(({ id, name, tagline, prompts, cards }) => ({
    id, name, tagline, prompts,
    cardCount: cards.length,
    preview: PREVIEW_PICKS
      .map(types => types.map(type => cards.find(card => card.type === type)).find(Boolean))
      .filter(Boolean)
      .map(card => ({ type: card.type, title: card.title })),
  }));
}

module.exports = { PERSONAS, PERSONA_IDS, findPersona, personaSummaries };
