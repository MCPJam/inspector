# Multi-surface agent parity

The agent contract is shared in `@mcpjam/surface-core`; each surface owns its
native renderer and delivery handles. This is the acceptance checklist for
the Slack and Discord implementations. Teams is intentionally marked as a
spike until Azure Bot provisioning and AAD proof are complete.

| Feature | Slack | Discord (MVP) | Teams |
| --- | --- | --- | --- |
| Agent turn | mention/DM | guild mention only | spike |
| Thread context | Slack replies/history | Gateway message history with adapter timestamps | spike |
| Live progress | Slack message update | bot message edit by id | spike |
| Proposals | Block Kit action | button `custom_id = actionId` | spike |
| Run watcher | `chat.update` | message edit | spike |
| Evidence | Slack upload | attachment messages | spike |
| Connect | Home tab link | `/mcpjam connect` ephemeral reply | spike |
| Private nudges | postEphemeral | interaction contexts only | unavailable in channels |
| Replay/dedupe | durable claims | durable claims with `discord:` prefix | `teams:` follow-on |
| Message length | Slack block limits | 2,000 character chunks, multiple handles | activity/card limits |

Discord DMs are not accepted: they do not provide a guild tenant and therefore
cannot be resolved to an authorized MCPJam organization.

## Discord deployment configuration

Set `MCPJAM_DISCORD_ENABLED=true`, `DISCORD_BOT_TOKEN`,
`DISCORD_APPLICATION_ID`, `DISCORD_SERVICE_TOKEN`,
`MCPJAM_DISCORD_SERVICE_TOKEN` (or use the same value for both service-token
variables), `MCPJAM_DISCORD_SERVICE_TOKEN_HASH`, `MCPJAM_BASE_URL`, and
`MCPJAM_CONVEX_HTTP_URL`. The inspector stores only the SHA-256 hash; the bot
holds the `dsc_` value. Account linking additionally uses `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET`, the generic surface-link session, and the existing
WorkOS OAuth configuration.
