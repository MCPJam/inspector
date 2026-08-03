import { CONNECT_ACTION_ID, PROJECT_PICKER_ACTION_ID, UNLINK_ACTION_ID } from './connect-builder.js';

/**
 * Build the App Home Block Kit view.
 *
 * The Home tab is where a user manages the CONNECTION itself — the one thing
 * they cannot do from a conversation, because it is about their account rather
 * than about anything being discussed. It shows exactly one of two states, so
 * there is never ambiguity about whether the bot can act for them.
 *
 * @param {{
 *   connected: boolean,
 *   connectUrl?: string,
 *   projects?: Array<{ id: string, name: string }>,
 *   defaultProjectId?: string | null,
 *   projectsError?: boolean,
 * }} [state]
 * @returns {import('@slack/types').HomeView}
 */
export function buildAppHomeView(state = { connected: false }) {
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
  ];

  if (!state.connected) {
    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            "*Your MCPJam account isn't connected yet.*\n" +
            'Connecting lets me act as _you_: everything I create lands in your own ' +
            'project, and I can only do what your account can do.',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: CONNECT_ACTION_ID,
            style: 'primary',
            text: { type: 'plain_text', text: 'Connect MCPJam' },
            ...(state.connectUrl ? { url: state.connectUrl } : {}),
          },
        ],
      },
    );
    return { type: 'home', blocks };
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*Your MCPJam account is connected.* :white_check_mark:',
    },
  });

  if (state.projectsError) {
    // Say what happened rather than rendering an empty picker, which would
    // read as "you have no projects" — a very different and alarming claim.
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ":warning: I couldn't load your projects just now. Reopen this tab in a moment.",
      },
    });
  } else {
    const projects = state.projects ?? [];
    // Slack rejects option text longer than 75 characters and more than 100
    // options outright — the whole `views.publish` fails rather than one row
    // being truncated, so both caps are applied here.
    const options = projects.slice(0, 100).map((project) => ({
      text: { type: /** @type {const} */ ('plain_text'), text: project.name.slice(0, 75) },
      value: project.id,
    }));
    const selected = options.find((option) => option.value === state.defaultProjectId);

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Default project*\nWhere your Slack work lands when a thread has no project of its own.',
      },
      ...(options.length > 0
        ? {
            accessory: {
              type: 'static_select',
              action_id: PROJECT_PICKER_ACTION_ID,
              placeholder: { type: 'plain_text', text: 'Pick a project' },
              options,
              ...(selected ? { initial_option: selected } : {}),
            },
          }
        : {}),
    });

    if (options.length === 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '_No projects yet — create one at <https://app.mcpjam.com|app.mcpjam.com> and reopen this tab._',
        },
      });
    }
  }

  blocks.push(
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: UNLINK_ACTION_ID,
          style: 'danger',
          text: { type: 'plain_text', text: 'Disconnect MCPJam' },
          // Slack's own confirm dialog: disconnecting is easy to click by
          // accident and stops the bot working for this person entirely.
          confirm: {
            title: { type: 'plain_text', text: 'Disconnect MCPJam?' },
            text: {
              type: 'mrkdwn',
              text: "I'll stop acting as you in Slack. Nothing you've already created is deleted.",
            },
            confirm: { type: 'plain_text', text: 'Disconnect' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Powered by the MCPJam public API — <https://app.mcpjam.com|open the app> to see your suites and runs.',
        },
      ],
    },
  );

  return { type: 'home', blocks };
}
