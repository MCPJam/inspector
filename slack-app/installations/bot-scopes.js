/**
 * The bot scopes MCPJam's install URL requests.
 *
 * This list MUST stay identical to `manifest.json`'s
 * `oauth_config.scopes.bot`. It is duplicated here rather than read from the
 * manifest because Bolt needs it at construction time and the manifest is not
 * shipped in the runtime image — and because getting it wrong is silent:
 *
 *   Bolt's HTTPReceiver defaults `scopes` to `undefined` and then passes
 *   `scopes ?? []` into the installer's `installUrlOptions`
 *   (`@slack/bolt/dist/receivers/HTTPReceiver.js:98,148`). Omitting `scopes`
 *   therefore does NOT mean "use the manifest" — it produces an install URL
 *   requesting ZERO bot scopes. That install succeeds, and the app then fails
 *   every API call with `missing_scope` at runtime, per workspace, with no
 *   error at install time to point at the cause.
 *
 * Sign in with Slack scopes (`openid`, `profile`) are deliberately ABSENT:
 * Slack rejects an authorize request that mixes SIWS user scopes with bot
 * scopes, and the account-link bridge builds its own separate SIWS URL.
 */
export const BOT_SCOPES = Object.freeze([
  'app_mentions:read',
  'channels:history',
  'chat:write',
  'groups:history',
  'im:history',
  // `im:write` is required to send the post-link confirmation DM. `im:read`
  // was dropped: nothing reads the DM channel list, and it is the broader of
  // the two.
  'im:write',
  'assistant:write',
]);
