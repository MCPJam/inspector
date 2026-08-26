---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

clients: agent surfaces can edit clients, in the product's own vocabulary

The UI's noun is **Client** — "a named, reusable configuration that defines how
MCPJam connects to and talks to your MCP servers". Every agent surface spoke
backend vocabulary instead (`/hosts`, `list_hosts…delete_host`,
`mcpjam cloud hosts …`), and the surfaces agents actually live on — the MCP
catalog, the agent operation registry — excluded client editing entirely.
Editing was also not robust: the only edit was a whole-config replace with no
partial patch and no concurrency token, so a caller that composed a replacement
from a stale read silently reverted whatever landed in between.

**Naming.** `/api/v1/projects/:projectId/clients` is canonical, with `Client*`
schemas and a `Clients` tag; the operations are `list_clients`, `get_client`,
`create_client`, `update_client`, `delete_client`, `set_client_servers` and
`duplicate_client`; the CLI is `mcpjam cloud clients …`. The old `/hosts`
routes, `cloud hosts` commands and `listHosts…duplicateHost` SDK methods all
keep working as deprecated compatibility surfaces on their ORIGINAL shapes —
`/hosts` still returns `hostConfigId` where `/clients` returns `configId`, so
the compatibility types are distinct interfaces rather than an alias that would
change a runtime shape. Alias responses carry `Deprecation: true`.

**Robust editing.** `PATCH /clients/:client` gains `set`: named fields applied
over the client's current config inside the write transaction, where absent
means keep and `null` means reset (for a required field) or clear (for an
optional one). Every config-affecting UPDATE — `update_client` and `set_client_servers`, not
the additive `create_client` / `duplicate_client`, which have no prior config to
be stale about — requires `expectedConfigId`, the content-addressed config id,
so the same id means byte-identical settings. Every rename requires
`expectedName`, because a rename does not rotate the config and config identity
is blind to a concurrent one. A stale token is a `409` carrying the current
value so the caller can re-read and retry. The canonical detail path takes a
client **name or ID**, resolved server-side, with the private User Testing
backing clients excluded by default exactly as the Clients tab excludes them.

**Exposure.** The two reads and four bounded writes are on the MCP catalog;
`create_client` / `update_client` / `set_client_servers` are gated proposals on
the agent registry. The line is bounded, preconditioned overwrite versus
resource removal: `delete_client` stays off both surfaces. Annotations stay
honest — create and duplicate advertise `destructiveHint: false`, update and
set-servers advertise `true`. A gated client-write proposal freezes its target
to an exact id, verifies the caller's tokens against a server read before
minting, and pins the impact its approval copy quotes, so a consumer attached
between proposing and clicking conflicts rather than silently widening what a
human agreed to.
