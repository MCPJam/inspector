/**
 * Build the App Home Block Kit view.
 * @returns {import('@slack/types').HomeView}
 */
export function buildAppHomeView() {
  /** @type {import('@slack/types').KnownBlock[]} */
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: ":wave: I'm the MCPJam agent.",
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'I turn Slack conversations into *eval suites* for your MCPJam project.\n\n' +
          'Send me a *direct message* or *mention me in a thread* — for example: ' +
          '_"@MCPJam create an eval suite from this thread"_. ' +
          "I'll author the cases and hand you a *Run it* button; runs only start when you click it.",
      },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Powered by the MCPJam public API — <https://app.mcpjam.com|open the app> to see your suites and runs.',
        },
      ],
    },
  ];

  return { type: 'home', blocks };
}
