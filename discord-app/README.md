# discord-app

MCPJam's Discord bot. Mention it in a server and it runs an agent turn against
your linked MCPJam project; actions that spend credits come back as buttons for
a human to approve.

Sibling of `slack-app`, on the same `surface-core` (envelope normalization,
turn-target resolution, run watching, connect links). Where the two differ it
is because Discord differs — threads are channels, buttons have a three-second
ack deadline — not because they drifted.

## Running it locally

```bash
cp .env.sample .env      # then fill in the tokens
npm install
npm start
```

You need a Discord application with a bot user, the **Message Content** intent
enabled (the bot reads the message it was mentioned in), and the bot invited to
a test server. Set `DISCORD_APPLICATION_ID` + `DISCORD_DEV_GUILD_ID` to register
`/mcpjam connect` in that one server — guild-scoped commands appear instantly,
global ones take up to an hour.

In production leave `DISCORD_DEV_GUILD_ID` unset: commands then register
globally, which is what gets `/mcpjam` into every server the bot is added to.
The older `DISCORD_GUILD_ID` is ignored (it used to be required, so honouring
it would pin existing deployments to one server); the bot warns at boot if it
is still set.

`npm test` runs the unit tests; none of them need a Discord connection.

## The two service tokens

The single thing most likely to cost you an afternoon. They are **not**
interchangeable and there is deliberately no fallback between them:

| Variable | Authenticates to | How |
|---|---|---|
| `DISCORD_SERVICE_TOKEN` | the **Convex** backend's `/agent/*` — event claims, thread bindings, presence | `x-discord-service-token` header |
| `MCPJAM_DISCORD_SERVICE_TOKEN` | the **Inspector**'s `/api/v1` and `/api/surface-link/session` | `dsc_` bearer, matched against `MCPJAM_DISCORD_SERVICE_TOKEN_HASH` set on the Inspector |

`config.js` resolves every variable once at boot and warns about each missing
piece by name. Only `DISCORD_BOT_TOKEN` is fatal; everything else degrades to a
describable state (no agent, no presence, no connect links) so a
half-provisioned deployment starts and tells you what it cannot do.

## How a turn works

1. **Mention** — the bot ignores everything else. `POSTHOG_DISCORD_AGENT_ENABLED`
   must be exactly `"true"` or it stays quiet.
2. **Claim** — the event is claimed backend-side under `guildId:messageId`, so
   a redelivered Gateway event runs the turn once.
3. **Resolve the target** — who is this, and which project are they acting in?
   Unlinked users get a connect link; linked users with no default project get
   told to pick one.
4. **Run** — recent messages become the history, the Inspector runs the turn,
   the reply is posted.
5. **Bind the thread** — after a turn succeeds inside a thread, the thread is
   bound to the project so later mentions there resolve without re-asking.

### Threads

A thread's **conversation is its parent channel**, and the thread is the
thread:

```text
in a thread   conversationId = channel.parentId
              threadId       = channel.id
in a channel  conversationId = channel.id
              threadId       = undefined
```

All of it lives in `context.js` and both the message path and the button path
use it, so a button clicked inside a thread resolves against the same
conversation the proposal was made in.

## Approvals

A proposed action arrives as a button. When someone clicks it:

- **the clicker is the authorizer** — the target is re-resolved for whoever
  clicked, not for whoever's message produced the proposal, so the server acts
  as them and re-checks their membership. A button left in a channel cannot be
  used to spend by someone who was never linked or has since been removed;
- **the click carries only an id** — what the action does comes from the
  persisted proposal, never from the button's payload;
- refusals are **ephemeral**, so a "connect your account first" is seen by the
  person who clicked and by nobody else.

Runs started this way are watched, and the status message is edited in place.
Failure evidence (screenshots) is uploaded **only for failed runs** — including
the shape a status-only check misses, a run that *completed* with
`result: "failed"`.

## Deployment

Railway, per `railway.toml`. Provisioning needs `RAILWAY_DISCORD_APP_TOKEN`
plus both service tokens above; the Inspector separately needs
`MCPJAM_DISCORD_SERVICE_TOKEN_HASH` set to the SHA-256 of the Inspector token.
