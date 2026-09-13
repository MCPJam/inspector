# MCPJam's own tools, published to browser agents

MCPJam's inspector actions — navigate, select a server, run a tool in the
playground — exist as a catalog of `ui_*` tools that run in the page. Two
agents can reach them:

- **Ask MCPJam**, the in-app agent, over MCPJam's own transport.
- **Any browser-native WebMCP agent**, over `document.modelContext`.

Both drive the same handlers, so an external agent operates the inspector the
same way the built-in one does — without anyone opening the Ask MCPJam side
panel.

Not to be confused with the **[WebMCP Inspector](./webmcp-inspector.md)**,
which is the other direction: a managed browser pointed at somebody else's
page, so the tools *that* page registers can be listed and invoked. This
document is about the tools MCPJam itself offers.

## Shape

```
client/src/lib/webmcp/
  ├ groups/                     the tool definitions, by surface
  ├ ui-tools-registry.ts        the catalog + `nativePublication` metadata
  ├ ui-tool-execution.ts        resolve → validate → run (both transports)
  ├ ui-tool-executor.ts         the Ask MCPJam adapter (approvals, transcript)
  ├ native-model-context.ts     the browser API seam + the WebMCP hints
  ├ native-tool-publisher.ts    the NATIVE adapter (registry → the browser)
  └ use-publish-native-ui-tools.ts   one mount at the App root
```

`ui-tool-execution.ts` is the seam. It resolves the name against the registry,
validates the arguments, runs the registered handler and returns a bounded,
JSON-serializable result with a status. Everything that exists only because
there is a conversation — the approval pill, the transcript, duplicate-call
suppression, the side-panel handoff — lives in the Ask MCPJam adapter, so a
native call creates no conversation and opens no panel.

## Which tools are published

Per definition, explicitly:

```ts
nativePublication: PUBLISH_NATIVE,            // ordinary inspector action
nativePublication: PUBLISH_NATIVE_UNTRUSTED,  // …whose result quotes a third party
nativePublication: nativeInternal("why not"), // Ask MCPJam only
// …and, for an action the browser should confirm even though MCP does not
// call it destructive:
nativePublication: publishNativeConsequential({ untrustedContent: false }),
```

Absent metadata reads as **internal**, so a new tool is never published by
accident; `agent-tool-coverage.test.ts` fails on a definition that does not
state its decision.

Internal today, and the only things that should be:

| Tool | Why |
| --- | --- |
| `ui_ask_user` | Paints a question card into the Ask MCPJam transcript and parks that turn on the answer. A native agent has neither. |
| `ui_eval_question`, `ui_eval_propose_cases`, `ui_eval_context` | Read and write the eval scope pinned to one Ask MCPJam conversation; they refuse without it. |

Everything else is an inspector action an external agent should be able to
drive.

## What MCPJam claims about a tool

Chrome's [secure tools
guidance](https://developer.chrome.com/docs/ai/webmcp/secure-tools) asks a page
to publish three hints. MCPJam states all three on every tool it publishes,
because an omitted hint reads as `false` and "we never said" is a different
claim from "no":

- **`readOnlyHint`** — copied from the tool's MCP annotations.
- **`untrustedContentHint`** — from the definition's own `nativePublication`.
  Not derivable from the MCP hints: `ui_snapshot_app` is read-only and
  closed-world and still returns a screen showing a third-party server's tool
  output.
- **`consequentialHint`** — derived: destructive actions (delete something,
  spend quota, consume billed infrastructure) plus mutating actions that reach
  an external system. Read-only tools are never consequential, even when they
  read across the network — gating reads teaches people to click through the
  prompts that matter. A definition can also declare it outright, and that
  wins: the two hints ask different questions, and a tool that only creates
  can still commit the organization to something. `ui_publish_scenario` is the
  live case — nothing is destroyed, but `access: "link_guests"` opens the
  scenario to signed-out visitors funded by the organization.

`exposedTo` is never set: these tools drive the user's own inspector session
and have no business being callable from another origin's page.

## Approvals

Each agent owns its own approval flow. Ask MCPJam keeps its Tool Approval
setting and its confirmation pill; an external agent's browser runs whatever
confirmation IT applies, which is what the hints above are for. Neither
bypasses MCPJam's ordinary application authorization: billing gates, quota
checks and the in-app confirmations a handler already performs apply to both,
because both run the same handler.

Failed calls are reported, never retried automatically — a UI tool can add a
server, run somebody's MCP tool, or spend quota, and a silent second attempt
is a second action.

## Browser support is a prerequisite

WebMCP ships as a Chrome origin trial. On a stock profile
`document.modelContext` does not exist, the publisher resolves nothing, and
MCPJam's own agent is unaffected — no error, no prompt, no degraded mode. To
see the tools published you need a browser where the API is live:

- **Chrome/Chromium with the feature flag:** launch with
  `--enable-features=WebMCP` (the minimal switch — see
  `server/services/webmcp-inspector/launch-args.ts` for why not the broader
  ones), or
- **an origin trial token** for the origin serving the inspector, or
- **MCPJam's own WebMCP Inspector**, which launches its browser with that
  switch already set. Pointing it at a running inspector lists MCPJam's tools
  like any other page's.

Everything asserted about the API was measured against the pinned Chromium
(151.0.7922.34, the build `webmcp-cdp.spike.test.ts` pins). The two facts the
publisher is built around:

1. **A duplicate name is rejected** (`InvalidStateError`), so a replacement
   registration cannot overlap its predecessor — work for one name is
   serialized.
2. **Unregistering during a call** is only guaranteed safe for in-flight
   executions from Chrome 153. So a registration with an accepted call stays
   standing until that call settles, marked dead meanwhile so anything new
   through it is refused.

## Testing

```bash
npx vitest run client/src/lib/webmcp client/src/lib/__tests__/agent-tool-coverage.test.ts
npx playwright test e2e/webmcp-native-tools.spec.ts   # real Chromium
```

The unit fake in `native-tool-publisher.test.ts` encodes the measured browser
behaviour rather than a convenient one; the Playwright spec drives the real
thing — discover MCPJam's tools over CDP in a Chromium with WebMCP on, invoke
`ui_navigate`, check the sidebar moved, then invoke a tool on the destination
and check its answer against the browser's own URL.

### By hand, through MCPJam itself

The one check no suite here can make for you, because the `/webmcp` workspace
sits behind a rollout flag and a device consent that a headless run cannot
resolve: point MCPJam's own WebMCP Inspector at a running MCPJam.

1. `npm run start` (or `npm run electron:dev`) and open the inspector.
2. WebMCP tab → In app → the inspector's own URL (`http://localhost:6274/`).
3. The tool list should fill with `ui_navigate`, `ui_snapshot_app`,
   `ui_execute_tool` and the rest — and with no `ui_ask_user` and no
   `ui_eval_*`.
4. Invoke `ui_navigate` with `{"target": "playground"}` and watch the embedded
   MCPJam move. Invoke `ui_snapshot_app` and check its `activeTab` against
   what the pane is showing.

Any browser agent that speaks WebMCP sees exactly this list; the inspector is
just the copy of one you already have.
