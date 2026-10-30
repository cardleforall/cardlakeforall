// What "Deal me 5" (api/_lib/surprise.js) deals from. We curate sources, not
// cards: each topic lists a few trusted channels and blogs, and their newest
// items are pulled in daily, so a deal never goes stale the way a fixed list of
// cards would. Editing this file is the only upkeep.
//
// Content rule, as for the starter personas: nothing here may read like someone
// else's life -- no names, weekdays, dates or appointments (test_surprise.py).

const TOPICS = [
  { id: 'ai', name: 'AI' },
  { id: 'productivity', name: 'Work & productivity' },
  { id: 'science', name: 'Science' },
  { id: 'money', name: 'Money' },
  { id: 'health', name: 'Health' },
  { id: 'history', name: 'History & ideas' },
];

const youtube = (id, name, topic, channelId) => ({ id: `yt:${id}`, name, topic, feed: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}` });
const blog = (id, name, topic, feed) => ({ id: `rss:${id}`, name, topic, feed });

const SOURCES = [
  youtube('two-minute-papers', 'Two Minute Papers', 'ai', 'UCbfYPyITQ-7l4upoX8nvctg'),
  youtube('ai-explained', 'AI Explained', 'ai', 'UCNJ1Ymd5yFuUPtn21xtRbbw'),
  youtube('anthropic', 'Anthropic', 'ai', 'UCrDwWp7EBBv4NwvScIpBDOA'),
  youtube('deepmind', 'Google DeepMind', 'ai', 'UCP7jMXSY2xbc3KCAE0MHQ-A'),
  youtube('karpathy', 'Andrej Karpathy', 'ai', 'UCXUPKJO5MZQN11PqgIvyuvQ'),
  blog('simon-willison', "Simon Willison's Weblog", 'ai', 'https://simonwillison.net/atom/everything/'),

  youtube('ali-abdaal', 'Ali Abdaal', 'productivity', 'UCoOae5nYA7VqaXzerajD0lg'),
  youtube('y-combinator', 'Y Combinator', 'productivity', 'UCcefcZRL2oaA_uBNeo5UOWg'),
  youtube('ted', 'TED', 'productivity', 'UCAuUUnT6oDeKwE6v1NGQxug'),
  blog('farnam-street', 'Farnam Street', 'productivity', 'https://fs.blog/feed/'),

  youtube('veritasium', 'Veritasium', 'science', 'UCHnyfMqiRRG1u-2MsSQLbXA'),
  youtube('kurzgesagt', 'Kurzgesagt', 'science', 'UCsXVk37bltHxD1rDPwtNM8Q'),
  youtube('scishow', 'SciShow', 'science', 'UCZYTClx2T1of7BRZ86-8fow'),
  youtube('pbs-space-time', 'PBS Space Time', 'science', 'UC7_gcs09iThXybpVgjHZ_7g'),
  blog('quanta', 'Quanta Magazine', 'science', 'https://www.quantamagazine.org/feed/'),

  youtube('plain-bagel', 'The Plain Bagel', 'money', 'UCFCEuCsyWP0YkP3CZ3Mr01Q'),
  youtube('ben-felix', 'Ben Felix', 'money', 'UCDXTQ8nWmx_EhZ2v-kp7QxA'),

  youtube('huberman', 'Andrew Huberman', 'health', 'UC2D2CMWXMOVWx7giW1n3LIg'),
  youtube('healthcare-triage', 'Healthcare Triage', 'health', 'UCabaQPYxxKepWUsEVQMT4Kw'),

  youtube('ted-ed', 'TED-Ed', 'history', 'UCsooa4yRKGN_zEE8iknghZA'),
  youtube('kings-and-generals', 'Kings and Generals', 'history', 'UCMmaBzfCCwZ2KqaBJjkj0fw'),
  youtube('oversimplified', 'OverSimplified', 'history', 'UCNIuvl7V8zACPpTmmNIqP2A'),
  blog('our-world-in-data', 'Our World in Data', 'history', 'https://ourworldindata.org/atom.xml'),
];

// Timeless picks, used only when the live pool can't fill a deal (before the
// first refresh, or if every feed is down).
const video = (topic, title, videoId, source) => ({ key: `evergreen:${videoId}`, topic, title, url: `https://www.youtube.com/watch?v=${videoId}`, source });
const EVERGREEN = [
  video('ai', 'But what is a neural network?', 'aircAruvnKk', '3Blue1Brown'),
  video('ai', 'Large language models explained briefly', 'LPZh9BOjkQs', '3Blue1Brown'),
  video('ai', 'Intro to large language models', 'zjkBMFhNj_g', 'Andrej Karpathy'),
  video('productivity', 'Inside the mind of a master procrastinator', 'arj7oStGLkU', 'TED'),
  video('productivity', 'Start with why', 'u4ZoJKF_VuA', 'TEDx'),
  video('productivity', 'How to speak', 'Unzc731iCUY', 'MIT OpenCourseWare'),
  video('science', 'The most misunderstood concept in physics', 'DxL2HoqLbyA', 'Veritasium'),
  video('science', 'Optimistic nihilism', 'MBRqu0YOH14', 'Kurzgesagt'),
  video('money', 'How the economic machine works', 'PHe0bXAIuk0', 'Ray Dalio'),
  video('health', 'Sleep is your superpower', '5MuIMqhT8DM', 'TED'),
  video('health', 'How to make stress your friend', 'RcGyVTAoXEU', 'TED'),
  video('health', 'Grit: the power of passion and perseverance', 'H14bBuluwB8', 'TED'),
  video('history', 'History of the entire world, I guess', 'xuCn8ux2gbs', 'Bill Wurtz'),
  video('history', '200 countries, 200 years, 4 minutes', 'jbkSRLYSojo', 'BBC'),
  video('history', 'Do schools kill creativity?', 'iG9CE55wbtY', 'TED'),
];

// The fifth card in every deal: a small thing to try, with no date attached.
const challenge = (topic, key, title) => ({ key: `challenge:${key}`, topic, title });
const CHALLENGES = [
  challenge('ai', 'explain-what-you-know', 'Try: ask an AI assistant about something you know well, and spot what it gets wrong'),
  challenge('ai', 'hand-off-a-chore', 'Try: hand one repetitive task to an AI assistant'),
  challenge('ai', 'ask-for-critique', 'Try: ask an AI assistant to critique something you wrote'),
  challenge('productivity', 'focus-block', 'Try: one 25-minute focus block with your phone in another room'),
  challenge('productivity', 'top-three', 'Try: write your top 3 priorities before opening email'),
  challenge('productivity', 'say-no', 'Try: say no to one thing that is not a priority'),
  challenge('science', 'two-sentences', 'Try: explain an idea you learned recently in two sentences'),
  challenge('science', 'how-do-we-know', 'Try: ask "how do we know that?" about one claim you read'),
  challenge('science', 'look-up', 'Try: spend five minutes looking at the night sky'),
  challenge('money', 'subscriptions', 'Try: list your subscriptions and cancel one you no longer use'),
  challenge('money', 'automate-savings', 'Try: set up one small automatic transfer into savings'),
  challenge('money', 'check-fees', 'Try: look up the fees on one account you hold'),
  challenge('health', 'walk-after-lunch', 'Try: a 10-minute walk after lunch'),
  challenge('health', 'water-first', 'Try: a glass of water before your next coffee'),
  challenge('health', 'earlier-bedtime', 'Try: go to bed 20 minutes earlier'),
  challenge('history', 'ask-a-relative', 'Try: ask an older relative about a moment in history they lived through'),
  challenge('history', 'birth-year', 'Try: read the Wikipedia page for the year you were born'),
  challenge('history', 'museum', 'Try: visit a museum or gallery, even an online one'),
];

// Topics pre-selected in the picker for someone who started from a persona.
const PERSONA_TOPICS = {
  agentic_exec: ['ai', 'productivity'],
  ai_builder: ['ai', 'science'],
  product_leader: ['productivity', 'ai'],
  curious_learner: ['science', 'history'],
};

const TOPIC_IDS = TOPICS.map(topic => topic.id);

module.exports = { TOPICS, TOPIC_IDS, SOURCES, EVERGREEN, CHALLENGES, PERSONA_TOPICS };
