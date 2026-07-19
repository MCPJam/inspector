# Spike (COMP-39): Can the Codex harness deliver a host's selected MCP servers?

**Answer: No — not by delivering a `~/.codex/config.toml`, and not in Codex v1.**
The blocker is an upstream Codex runtime limitation, not a merge/clobber problem on
our side. `deliverMcpServers` for Codex would *look* like it works (the file survives)
but the model would never see the tools. **Do not flip `supportsSelectedMcpServers` to
`true` for Codex.**

Audited 2026-07-18 against `@ai-sdk/harness-codex@1.0.0-canary.9`
(bridge pins `@openai/codex-sdk@0.130.0`).

---

## The question, precisely

The task asked one sharp question: if MCPJam writes `~/.codex/config.toml` (`mcp_servers`)
into the sandbox before the turn, does the bridge's programmatic
`codexConfig.mcp_servers` (set only when host tools are present) **MERGE with** or
**CLOBBER** that file? And it asked to test both cases — host tools present and absent.

## What the bridge actually does (evidence)

`node_modules/@ai-sdk/harness-codex/dist/bridge/index.mjs`, `runTurn()`:

- L522–557: `mcpServers` starts `{}`. The bridge adds a single `"harness-tools"` entry
  **only when `start.tools` is non-empty** (host-executed AI SDK tools). It never adds
  entries for arbitrary user MCP servers — there is no pass-through.
- L556–557: `codexConfig.mcp_servers` is assigned **only if** `mcpServers` is non-empty.
  So with no host tools, `codexConfig` has no `mcp_servers` key at all.
- L573–582: `codexConfig` is passed **in memory** as `config:` to
  `new codexSdk.Codex({ ..., config: codexConfig })`. The bridge does **not** write
  `~/.codex/config.toml` (the only `writeFile` in the bridge, L550, is the CLI shim).

How the SDK delivers `config` (OpenAI Codex TS SDK, verified against the public docs):
it flattens the object into dotted paths and passes them as repeated
`--config key=value` (`-c`) flags to `codex exec`. Codex precedence layers `-c` flags
**on top of** `~/.codex/config.toml` at the *key path* level.

### Merge vs clobber — both cases

| Case | Bridge sets `codexConfig.mcp_servers`? | Effect on our `config.toml` `mcp_servers` |
|---|---|---|
| **Host tools present** | Yes: `{ "harness-tools": {…} }` → `-c mcp_servers.harness-tools.*` | **Merges.** Distinct key path; our `mcp_servers.<userServer>` entries survive. |
| **Host tools absent** | No `mcp_servers` key at all | **Merges (untouched).** No `-c mcp_servers.*` flags emitted; our file is the only source. |

**So the answer to the literal question is: MERGE, not clobber, in both cases.** Writing
`config.toml` is mechanically safe.

## Why that isn't enough — the real blocker

Even with a perfectly-merged `mcp_servers` table, the tools never reach the model.

**The proof is the shipped code, not a GitHub issue.**
`node_modules/@ai-sdk/harness-codex/src/bridge/cli-relay.ts` (L1–27) states directly that
MCP tools registered via `mcp_servers.*` are **not exposed to the model in
`codex exec --experimental-json` mode** — which is exactly the mode `@openai/codex-sdk`
uses (`thread.runStreamed`). The MCP handshake completes and `tools/list` succeeds, but
Codex never registers the tools as model-callable functions.

The decisive evidence is that **the harness authors hit this same wall for their own
host tools.** They could not expose `harness-tools` through `mcp_servers` either, so they
built the `cli-relay` workaround: describe each tool in the prompt and have the model
shell out via `bash <shim> <toolName> <json>` to an HTTP relay (wired at
`dist/bridge/index.mjs:525-554`). If `mcp_servers` worked in exec mode, that entire
workaround would not exist. This is version-pinned to what we ship — it does not depend on
the state of any external tracker.

The upstream tracker the authors reference is **openai/codex#19425**. Note (verified
2026-07-18): that issue's current title/body describe the **Codex Desktop** surface
("stdio MCP server discovered by `/mcp` but tools not exposed to threads"), not the
`codex exec` path — same root-cause class (discovered via `tools/list`, never made
model-callable), different surface. Corroborating the recurring pattern: openai/codex
#3441, #9676, #13025 ("MCP servers defined in config.toml not detected/used"). Treat these
as supporting context; the `cli-relay` code above is the authoritative evidence.

## Consequence for the implementation

`deliverMcpServers` on `codexAdapter` writing `config.toml` would be a **silent no-op
trap**: the file merges, the handshake succeeds, and the model still can't call the
tools. Flipping `supportsSelectedMcpServers: true` on that basis would lift the preflight
gate and let users attach servers that appear connected but do nothing — strictly worse
than today's hard block. **Do not do it.**

## The only known path that could actually work (for the GA task, not this spike)

Mirror the host-tool relay for user MCP servers: represent each selected server's tools
as **host-executed AI SDK tools** (`start.tools`) that MCPJam's server runs by calling
the user's server **through the existing signed MCP proxy** (`routes/web/harness-mcp.ts`,
same route Claude Code uses — no direct server URLs handed to Codex). The bridge already
relays these via the CLI shim, sidestepping #19425 entirely.

This is a substantially larger lift than `deliverMcpServers` (tool schemas must be
enumerated up front; tools execute host-side, not in-sandbox; approval/streaming
semantics differ) and belongs to the "Codex host to GA quality" task. It is noted here so
that task starts from the right mechanism.

## Decisions this spike hands off

1. **Launch call (Marcelo, product):** ship Codex with MCP unsupported, or hold Codex
   from launch? This spike only establishes that Codex+MCP is not achievable via
   `config.toml` and is a real engineering project via the relay path. Record the call on
   COMP-39.
2. **If we ship Codex without MCP:** the limit must surface at **host creation** (before a
   user attaches a server), not as a post-hoc turn error. The gate that produces the error
   is capability-driven (`harness-availability.ts`, `supportsSelectedMcpServers`); the
   frontend host-creation flow should read the same capability and disable/annotate server
   selection for Codex hosts. (Frontend work — contingent on decision 1.)

## Done in this spike

- Error copy fixed (`harness-availability.ts`): the old text told users to "remove the
  selected servers" with no reason and no alternative. New copy explains it's an upstream
  Codex runtime limitation and points them to a Claude Code host. Test updated
  (`__tests__/harness-availability.test.ts`).
- `supportsSelectedMcpServers` stays `false`; no `deliverMcpServers` added for Codex. The
  "blocks a Codex host that has selected MCP servers" test stays (still the correct
  behavior) — only its message assertion changed.
