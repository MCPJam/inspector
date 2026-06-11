# Handoff: MCPJam built-in tools for the in-app agent

> Status: **slice 1 in progress** — the tool module is written; wiring, tests, and the
> backend catalog rows remain. Delete this file before merging.

## Goal

Give the chat agent (web chat-v2 / playground / future copilot) first-class tools to act
on the MCPJam workspace itself — list project servers, diagnose connections, and run
live MCP ops (tools/prompts/resources) against **any saved server**, not just the ones
selected into the chat. Navigation/frontend tools are explicitly **phase 2**.

Design follows the PostHog Max / Arize Alyx pattern survey (read-heavy toolset, writes
gated by approval, ids = tool names) and reuses the same cores as the public `/api/v1`
surface — no forked handler logic.

## Decisions already made (and why)

| Decision | Rationale |
|---|---|
| Per-tool catalog ids `mcpjam_*` (9 ids), not one bundle id | Backend invariant: "a catalog id doubles as the AI SDK tool name" (`convex/lib/builtInTools.ts`). Also gives hosts read-only granularity (enable diagnostics without `mcpjam_call_tool`). |
| Extend `resolveHostTools()` registry, nothing else | It's THE single host-config → ToolSet path for every engine (chat routes, eval runners, sessionSimulation, docs agent). |
| Live ops injected as a `McpjamLiveOps` runner from the chat route | The authorize→connect→run pipeline (`runEphemeralConnection`) is route-layer and context-bound. Engines that don't pass the runner simply never advertise those tools — same philosophy as `computer`/bash ("callers pass what their surface resolved"). |
| Catalog reads hit Convex `/v1/*` directly with the caller's bearer | Same pattern as `exa-web-search.ts`; works on every engine, no Hono context needed. |
| `mcpjam_call_tool` sets `needsApproval: requireToolApproval === true` | Mirrors bash exactly; it's the only side-effectful tool in the set. |
| Guests: skip ALL `mcpjam_*` ids at advertise time | Matches the `/api/v1` boundary decision ("Guests cannot access /api/v1", `server/routes/v1/index.ts`). |
| Tool `execute` returns `{ error: string }`, never throws | House style (exa/bash) — keeps the model turn alive. |

## Done

- `server/utils/built-in-tools/mcpjam.ts` — all 9 tool builders, `McpjamLiveOps`
  interface, `MCPJAM_TOOL_IDS`, `isMcpjamToolId()`, `buildMcpjamTool(id, opts)`
  dispatcher (returns `null` when an id needs the runner and none was provided).
  **Not yet typechecked** — run the workspace typecheck before anything else.

## Remaining work (in order)

### 1. Registry wiring — `server/utils/built-in-tools/registry.ts`

- Add to `BuiltInToolContext`: `mcpjamLiveOps?: McpjamLiveOps` (import type from
  `./mcpjam.js`).
- In the `for (const id of ids)` loop (after the bash branch, before the unknown-id
  warn):

```ts
if (isMcpjamToolId(id)) {
  if (ctx.isGuest) {
    logger.debug("[built-in-tools] mcpjam tools not advertised to guest actor; skipping", { id });
    continue;
  }
  const built = buildMcpjamTool(id, {
    authHeader,
    projectId: ctx.projectId,
    liveOps: ctx.mcpjamLiveOps,
    requireToolApproval: ctx.requireToolApproval,
  });
  if (!built) {
    logger.debug("[built-in-tools] mcpjam live-op id without a runner; skipping", { id });
    continue;
  }
  out[id] = built;
  continue;
}
```

- Update the module-header comment (it documents every gate by design — add the
  mcpjam ids, the `mcpjamLiveOps` gate, and the guest gate).

### 2. Live-ops factory — new file `server/routes/web/mcpjam-live-ops.ts`

Route layer on purpose (it imports from `./auth.js` / `./servers.js`). Shape:

```ts
import { runEphemeralConnection, toolsListSchema, toolsExecuteSchema,
  promptsListSchema, promptsGetSchema, resourcesListSchema, resourcesReadSchema,
} from "./auth.js";
import { runHostedDoctor } from "./servers.js";
import { listTools, listPrompts, getPrompt, listResources, readResource,
} from "../../utils/route-handlers.js";
import { WEB_CONNECT_TIMEOUT_MS } from "../../config.js";
import type { McpjamLiveOps } from "../../utils/built-in-tools/mcpjam.js";
import type { Context } from "hono";

export function buildMcpjamLiveOps(c: Context, projectId: string): McpjamLiveOps {
  return {
    doctor: (serverId, _abortSignal) =>
      runHostedDoctor(c, { projectId, serverId }, WEB_CONNECT_TIMEOUT_MS),
    listTools: (serverId, cursor, _abortSignal) =>
      runEphemeralConnection(c, { projectId, serverId, cursor }, toolsListSchema,
        (manager, body) => listTools(manager, body)),
    callTool: (serverId, toolName, parameters, _abortSignal) =>
      runEphemeralConnection(c, { projectId, serverId, toolName, parameters },
        toolsExecuteSchema,
        (manager, body) => manager.executeTool(body.serverId, body.toolName, body.parameters)),
    getPrompt: (serverId, name, args, _abortSignal) =>
      runEphemeralConnection(c, { projectId, serverId, promptName: name, arguments: args },
        promptsGetSchema,                       // NB: schema field is `promptName`, not `name`
        (manager, body) => getPrompt(manager, body)),
    // listPrompts / listResources / readResource: same shape with
    // promptsListSchema/resourcesListSchema/resourcesReadSchema.
  };
}
```

Abort semantics (Bugbot round 1): every `McpjamLiveOps` method takes a trailing
`abortSignal?: AbortSignal`, and the tool layer pre-checks `aborted` before
dispatching. `runEphemeralConnection` has no signal parameter today, so the
factory can ignore the signal initially (`_abortSignal`) — threading it into the
manager/timeout layer is optional hardening, not required for slice 1.

Reference implementations: `server/routes/v1/{tools,prompts,resources,servers}.ts`
call the identical cores via `runV1ServerOp` (`server/routes/v1/adapter.ts`). Notes:

- `runEphemeralConnection` is at `server/routes/web/auth.ts:1080`; it resolves the
  bearer itself (`getConvexBearerForRequest`) and handles manager lifecycle.
- v1 rejects `taskOptions` on tools/call — programmatic bodies here never set it.
- v1 drops the inspector-only `toolsMetadata`/`tokenCount` enrichments from
  `listTools` at the public boundary; consider projecting to `result.tools` here
  too to keep model context lean.

### 3. Chat route wiring — `server/routes/web/chat-v2.ts` (~line 219)

In the existing `resolveHostTools(...)` call, add to the ctx object:

```ts
mcpjamLiveOps: buildMcpjamLiveOps(c, hostedBody.projectId),
```

Cheap closures; gating stays in the registry. Leave `/api/mcp/chat-v2` (local mode)
alone for now — no Convex there.

### 4. Tests

- Extend `server/utils/__tests__/built-in-tools-registry.test.ts` (style is in-file):
  - catalog id (`mcpjam_list_servers`) resolves with ctx and **without** liveOps;
  - live id (`mcpjam_call_tool`) is skipped without liveOps, resolves with a stub;
  - guest ctx ⇒ no `mcpjam_*` ids advertised;
  - `requireToolApproval: true` ⇒ `mcpjam_call_tool` has `needsApproval === true`,
    and read tools don't.
- New `server/utils/__tests__/mcpjam-built-in-tools.test.ts` for execute paths,
  mirroring `computers-bash-tool.test.ts` conventions (`vi.stubEnv("CONVEX_HTTP_URL", …)`,
  `vi.stubGlobal("fetch", …)`):
  - list_servers: 200 passthrough; non-OK uses upstream `message`; missing
    CONVEX_HTTP_URL ⇒ `{ error }`;
  - call_tool: forwards (serverId, toolName, parameters) to the stub runner;
    runner throwing `WebRouteError` ⇒ `{ error: message }`.

### 5. Backend catalog rows — `mcpjam-backend/convex/builtInTools/catalog.ts`

Append 9 rows to `SEED_ROWS` (ids must match `MCPJAM_TOOL_IDS` exactly; grammar
`^[a-z][a-z0-9_]{0,63}$` already satisfied). All: `category: 'mcpjam'`,
`billable: false`, no `requiresComputer`. Suggest `enabled: true` for the read
tools and decide deliberately for `mcpjam_call_tool` (the bash precedent seeded
disabled until launch-ready). Then run, per deployment:

```sh
npx convex run builtInTools/catalog:seedBuiltInTools
```

`validateBuiltInToolScope` needs no changes. The AttachmentEditor renders new rows
automatically (live `listBuiltInTools` subscription) — **zero client code needed**.
If catalog rows go enabled before the inspector deploy, the registry warns + skips
unknown ids by design (documented drift path).

### 6. Verify

```sh
# inspector workspace
npm run typecheck -w @mcpjam/inspector   # check exact script name in its package.json
npm run test -w @mcpjam/inspector
```

Manual: enable the ids on a host config (AttachmentEditor) → in chat ask
"diagnose <server name>" → expect `mcpjam_list_servers` then `mcpjam_diagnose_server`
calls; with approval ON, `mcpjam_call_tool` must show the Approve/Deny pill
(`client/src/components/chat-v2/thread/parts/tool-part.tsx`).

## Key file map (from exploration)

| What | Where |
|---|---|
| Host-tool resolver (THE seam) | `server/utils/built-in-tools/registry.ts:112` |
| Tool patterns to mirror | `built-in-tools/exa-web-search.ts`, `built-in-tools/bash.ts` |
| Chat tool assembly + collision guard | `server/utils/chat-v2-orchestration.ts:528-632` |
| resolveHostTools call site (web chat) | `server/routes/web/chat-v2.ts:219-234` |
| Ephemeral authorize→connect→run | `server/routes/web/auth.ts:1080` (`runEphemeralConnection`) |
| Doctor | `server/routes/web/servers.ts:147` (`runHostedDoctor`) |
| MCP op cores | `server/utils/route-handlers.ts` |
| v1 equivalents (reference) | `server/routes/v1/*` |
| builtInToolIds flow (chatbox vs body) | `server/utils/host-execution-context.ts`, `server/utils/chatbox-runtime-config.ts` |
| Backend catalog + id rules | `mcpjam-backend/convex/builtInTools/catalog.ts`, `convex/lib/builtInTools.ts` |

## Phase 2 (deliberately deferred)

- `mcpjam_run_eval` / `mcpjam_get_eval_run` (async POST + poll, v1 evals surface).
- Navigation/frontend tools (`navigate`, prefilled connect card) — the AG-UI-style
  client-executed tools discussed for the "connect to this server" flow.
- `/api/mcp/chat-v2` (local/OSS mode) support.
- Trimming large `listTools` results before they hit model context.
- System-prompt guidance telling the model when to reach for `mcpjam_*` tools
  (per the tool-triggering lessons — prescriptive "call this when…" descriptions
  are already in the tool definitions).
