/**
 * Block Kit for the two states a user can be in before they can be served:
 * not linked, and linked-but-no-project.
 *
 * Both are UX states, not errors. A first-time user in a workspace that just
 * installed the app has done nothing wrong, and an error-shaped message would
 * read as "the bot is broken" rather than "here is the one thing to do".
 */

export const CONNECT_ACTION_ID = 'mcpjam_connect_account';
export const UNLINK_ACTION_ID = 'mcpjam_unlink_account';
export const PROJECT_PICKER_ACTION_ID = 'mcpjam_pick_default_project';

/**
 * "Connect MCPJam" — shown to an unlinked user.
 *
 * The button carries the connect URL rather than the flow being started by the
 * click, because the URL is minted per user and expires: generating it at
 * render time keeps the clock honest, and a click that merely opens a link is
 * one round trip fewer than a click that has to mint one first.
 *
 * @param {string | null | undefined} url  Absent when the mint failed.
 * @returns {import('@slack/types').KnownBlock[]}
 */
export function buildConnectBlocks(url) {
  if (!url) {
    // Slack rejects a `url`-less link button outright, so a failed mint would
    // fail the whole post and the user would get nothing at all. Say what
    // happened instead — and do not imply the fault is theirs.
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ":warning: *I couldn't prepare a connection link just now.* Try me again in a moment.",
        },
      },
    ];
  }
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Connect your MCPJam account to get started.*\n' +
          "I'll act as _you_ — everything I create lands in your own project, " +
          'and I can only do what your account can do.',
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
          url,
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '_This link is for you and expires in 10 minutes. It only works when opened by your Slack account._',
        },
      ],
    },
  ];
}

/**
 * Shown to a linked user who has not picked a default project yet.
 * @param {string | null | undefined} appHomeUrl  Absent when the app id is unknown.
 * @returns {import('@slack/types').KnownBlock[]}
 */
export function buildPickProjectBlocks(appHomeUrl) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Your account is connected — I just need to know where to put things.*\n' +
          (appHomeUrl
            ? 'Pick a default project and I can get going.'
            : 'Open my *Home* tab and pick a default project, and I can get going.'),
      },
    },
    // Without an app id the deep link points at nothing; a button that opens
    // nowhere is worse than the sentence above, which the user can act on.
    ...(appHomeUrl
      ? [
          /** @type {import('@slack/types').KnownBlock} */ ({
            type: 'actions',
            elements: [
              {
                type: 'button',
                action_id: 'mcpjam_open_home',
                text: { type: 'plain_text', text: 'Pick a project' },
                url: appHomeUrl,
              },
            ],
          }),
        ]
      : []),
  ];
}

/**
 * Deep link to the app's Home tab. Slack has no first-party URL for "open my
 * App Home", so this uses the documented `slack://` app form with an https
 * fallback the desktop client rewrites.
 * @param {string} teamId
 * @param {string} appId
 */
export function appHomeDeepLink(teamId, appId) {
  return `slack://app?team=${encodeURIComponent(teamId)}&id=${encodeURIComponent(appId)}&tab=home`;
}
