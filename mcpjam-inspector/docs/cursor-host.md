# Cursor CLI client

A Cursor client runs the real Cursor CLI (`agent`) on the customer's own Cursor
account. MCPJam mints no model lease for it, so there is one credential in play:
a project secret named `CURSOR_API_KEY`.

## The key

- **Brokered, never materialized.** The key is a brokered secret for
  `api2.cursor.sh`, header `authorization`, template `Bearer {}`. The sandbox's
  egress proxy attaches it outside the VM; the plaintext never enters the box.
- **Created with the client.** Add client → Cursor asks for your key when you
  have no usable one, and stores it as your personal brokered secret (fixing
  your own mis-bound one in place). You can also create it under Project
  Settings → Secrets with the same binding.
- **Your own key, always.** Each member runs Cursor on their own personal key.
  A project-shared key is never selected: the agent has a shell, and although
  the key itself never enters the box, the CLI trades it for a session token
  that does — anyone who can run the client could read that token back.
- **One selector.** The composer, host creation and the Playground all pick the
  key with `externalCredentialSecretSelection`
  (`shared/external-credential-selection.ts`), so a client is never composed
  without it.

## The CLI

The CLI is baked into the default computer template at a pinned version
(`CURSOR_CLI_VERSION` in `server/utils/harness/cursor-bootstrap.ts`) and verified
against a checksum before it is linked. A box from a current template logs
`bootstrap=baked`; an older template or a custom image installs the same pinned
version at turn time.

Cursor takes no model lease: its model usage is billed to your own Cursor
account, not metered by MCPJam. The box it runs on is a disposable terminal box,
bounded by the same per-member and per-organization box limits as any other.

## Where each client runs

| Surface | Claude Code | Codex | Cursor |
|---|---|---|---|
| Playground, one column | Your personal computer (created on first use) | Same | Disposable per-conversation box, carrying your key |
| Playground compare | Disposable box per column | Same | Same |
| Evals and swarms | Disposable box on the default template | Same | Same |
| User Testing | Disposable scenario box | Same | Not available: Cursor signs in with a personal account, and participants can't use it |
| Hosted chat API (v1) | Disposable box | Same | Same |

User Testing never runs on a persistent machine. Secrets reach only disposable
boxes, through an environment's grant; in the Playground, when you have not
chosen an environment, a hidden one carries just your Cursor key.

## Failure modes

| Condition | What you see |
|---|---|
| No `CURSOR_API_KEY` of your own | Refused before any box starts, saying to add it under Project Settings → Secrets. |
| Key exists but binds the wrong host/header/template | Refused, describing the binding it needs. |
| Only a project-shared key | Refused, asking you to add your own. |
| A User Testing participant | Refused with copy that names no project settings; no box starts. |
| Require tool approval with selected MCP servers | Pre-flight error: the Cursor adapter does not yet gate MCP calls. |
| Harness unavailable for this turn | `422 FEATURE_NOT_SUPPORTED` from the chat routes (`details.reason: "HARNESS_UNAVAILABLE"` with the `kind`); a server-side operator state (broker delivery off, no computers data plane) stays `503`. |
