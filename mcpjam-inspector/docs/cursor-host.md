# Cursor CLI client

A Cursor client runs the real Cursor CLI (`agent`) on the customer's own Cursor
account. MCPJam mints no model lease for it, so there is one credential in play:
a project secret named `CURSOR_API_KEY`.

## The key

- **Brokered, never materialized.** The key is a brokered secret for
  `api2.cursor.sh`, header `authorization`, template `Bearer {}`. The sandbox's
  egress proxy attaches it outside the VM; the plaintext never enters the box.
- **Created with the client.** Add client → Cursor asks for the key when the
  project has none, and stores it as a personal brokered secret. You can also
  create it under Secrets with the same binding.
- **Personal vs shared.** A personal key reaches only its owner's runs. A
  project admin shares it so teammates and User Testing participants can run
  the client. A participant who is not a project member can run Cursor only on a
  scenario whose environment selects a **project-shared** key.
- **One selector.** The composer, host creation and the box all pick the key
  with `externalCredentialSecretSelection` (`shared/external-credential-selection.ts`),
  so a client is never composed without it. Project-shared wins over personal.

## The CLI

The CLI is baked into the default computer template at a pinned version
(`CURSOR_CLI_VERSION` in `server/utils/harness/cursor-bootstrap.ts`) and verified
against a checksum before it is linked. A box from a current template logs
`bootstrap=baked`; an older template or a custom image installs the same pinned
version at turn time.

Cursor takes no model lease, so the per-account box caps are its only bound.

## Where each client runs

| Surface | Claude Code | Codex | Cursor |
|---|---|---|---|
| Playground, one column | Your personal computer when you have one, else a disposable box | Same | Disposable per-conversation box (needs the key) |
| Playground compare | Disposable box per column | Same | Same |
| Evals and swarms | Disposable box on the default template | Same | Same |
| User Testing (member or participant) | Disposable scenario box | Same | Same; participants need a project-shared key |
| Hosted chat API (v1) | Disposable box | Same | Same |

User Testing never runs on a persistent machine. Secrets reach only disposable
boxes, through the run's environment.

## Failure modes

| Condition | What you see |
|---|---|
| No `CURSOR_API_KEY` | Pre-flight error naming it. |
| Key exists but binds the wrong host/header/template | Pre-flight error describing the binding it needs. |
| Personal key on a surface with other participants | Pre-flight error asking an admin to share it. |
| Require tool approval with selected MCP servers | Pre-flight error: the Cursor adapter does not yet gate MCP calls. |
| Harness unavailable for this turn | `422 FEATURE_NOT_SUPPORTED` from the chat routes. |
