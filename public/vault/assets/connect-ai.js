// The one copy of "how to connect Claude, ChatGPT, Gemini or Hermes to Cardlake". The setup
// guide (mcp-setup.html), onboarding (welcome.html) and the vault's Connect AI
// panel all render from here, so the steps can't drift apart.
(function () {
  'use strict';
  // This deployment's own address: every Cardlake is its own MCP server, and
  // must never send assistants to someone else's. Claude and ChatGPT connect
  // from their own servers, so a dev machine's localhost won't work for them;
  // a deployed copy's address does.
  const SERVER_ADDRESS = `${location.origin}/api/mcp`;

  const signInStep = 'A Cardlake sign-in window opens. Sign in and click <strong>Authorize</strong>.';
  const CLIENTS = {
    claude: {
      name: 'Claude',
      where: 'Claude.ai or Claude Desktop',
      steps: [
        'In Claude, open <strong>Settings &rarr; Connectors</strong> and click <strong>Add custom connector</strong>.',
        'Name it <strong>Cardlake</strong> and paste the address above.',
        signInStep,
      ],
    },
    chatgpt: {
      name: 'ChatGPT',
      where: 'ChatGPT',
      steps: [
        'In ChatGPT, open <strong>Settings &rarr; Connectors</strong> (under Plugins) and add a custom connector.',
        'Name it <strong>Cardlake</strong> and paste the address above.',
        signInStep,
      ],
      // ChatGPT keeps its own copy of a connector's tool list and never
      // refreshes it on its own.
      note: 'If Cardlake’s tools ever look out of date, open the connector in ChatGPT and click <strong>Refresh tools</strong>.',
    },
    gemini: {
      name: 'Gemini',
      where: 'Gemini',
      steps: [
        'In Gemini, open <strong>Customise</strong>, then <strong>Connectors</strong>, and click <strong>Custom</strong>.',
        'Paste the address above and click <strong>Next</strong>.',
        signInStep,
      ],
    },
    hermes: {
      name: 'Hermes',
      where: 'Hermes Agent',
      steps: [
        `In <code>~/.hermes/config.yaml</code>, add:<pre><code>mcp_servers:\n  cardlake:\n    url: "${SERVER_ADDRESS}"\n    auth: oauth</code></pre>`,
        'In a terminal, run <code>hermes mcp login cardlake</code>.',
        signInStep,
      ],
      note: 'Hermes on a remote server? After you click <strong>Authorize</strong>, your browser shows a connection error. That&rsquo;s expected: copy the address from that page and paste it into the terminal where Hermes is waiting.',
    },
  };

  const EXAMPLE_PROMPTS = [
    'What’s in my Cardlake feed today?',
    'Add a reminder to call the dentist tomorrow',
    'Show me my bookmarks tagged as tech',
    'Mark my “finish the report” work item as done',
  ];

  // Typed into Hermes, which reads its own conversations and adds the cards.
  // They live here rather than on the MCP server, which every assistant shares.
  const HERMES_PROMPTS = [
    'Add up to 3 cards to Cardlake from today’s conversations. Note which conversation each came from, leave out passwords and keys, and list what you added.',
    'Add up to 3 cards to Cardlake from yesterday’s conversations. Note which conversation each came from, leave out passwords and keys, and list what you added.',
    'Add up to 3 cards to Cardlake from the past week’s conversations. Note which conversation each came from, leave out passwords and keys, and list what you added.',
    'Every morning at 8, recap yesterday’s conversations and send it to me on Telegram. Leave out passwords and keys, and end by asking if I’d like to add up to 3 cards to Cardlake.',
  ];

  const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function stepsHtml(clientId, listClass = '') {
    const client = CLIENTS[clientId];
    return `<ol class="${escapeHtml(listClass)}">${client.steps.map(step => `<li>${step}</li>`).join('')}</ol>${client.note ? `<p class="connect-ai-note">${client.note}</p>` : ''}`;
  }

  function promptsHtml(prompts = EXAMPLE_PROMPTS, listClass = '') {
    return `<ul class="${escapeHtml(listClass)}">${prompts.map(prompt => `<li>&ldquo;${escapeHtml(prompt)}&rdquo;</li>`).join('')}</ul>`;
  }

  // Fills static pages: <div data-connect-ai-steps="claude"> and
  // <div data-connect-ai-prompts>; data-list-class styles the list.
  function mount(root = document) {
    root.querySelectorAll('[data-connect-ai-steps]').forEach(el => { el.innerHTML = stepsHtml(el.dataset.connectAiSteps, el.dataset.listClass); });
    root.querySelectorAll('[data-connect-ai-prompts]').forEach(el => { el.innerHTML = promptsHtml(EXAMPLE_PROMPTS, el.dataset.listClass); });
    root.querySelectorAll('[data-connect-ai-hermes-prompts]').forEach(el => { el.innerHTML = promptsHtml(HERMES_PROMPTS, el.dataset.listClass); });
    root.querySelectorAll('[data-connect-ai-address]').forEach(el => { el.textContent = SERVER_ADDRESS; });
  }

  window.CardleConnectAI = { SERVER_ADDRESS, CLIENTS, EXAMPLE_PROMPTS, HERMES_PROMPTS, stepsHtml, promptsHtml, mount };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mount());
  else mount();
})();
