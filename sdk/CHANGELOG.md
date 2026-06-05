# `@mcpjam/sdk` changelog

## Unreleased — Stage 4 (HostRunner rename + HostRuntime binding)

**Breaking changes** — ship as the next major.

### Renamed surface

- `TestAgent` → `HostRunner` (class) and `TestAgentConfig` → `HostRunnerConfig`.
- `EvalAgent` → `HostExecutor` (interface). `HostRunner` and `HostRuntime` both implement it.
- `.prompt(message, options)` → `.run(message, options)` on `HostRunner`, `HostRuntime`, and the `HostExecutor` interface.
- `Host.addServer(id)` → `Host.requireServer(id)`.
- `Host.removeServer(id)` → `Host.removeRequiredServer(id)`.
- `EvalTest.run(agent, options)` / `EvalSuite.run(agent, options)` now take a `HostExecutor` (parameter renamed to `executor`).

No deprecation aliases. Pre-Stage-4 names are removed.

### `Host` becomes the primary spec

- `HostRunnerConfig.host` accepts `Host | HostInit | HostJson`. When supplied, the runner derives defaults for `model`, `systemPrompt`, `temperature`, and `injectOpenAiCompat` from the host snapshot (explicit fields still win).
- `HostRunnerConfig` is now a discriminated union: callers supply either a `host` (with optional `model`) **or** an explicit `model`. A config missing both is a compile-time error.
- `HostRunner` snapshots the host once at construction via `snapshotHostSource(...)`. A pre-snapshotted `HostJson` (e.g. one produced by `HostRuntime.run()`) passes through untouched — no double-snapshot. Post-construction mutations to the original `Host` do NOT affect the runner.
- New public accessors on `HostRunner`: `getHostSnapshot()`, `getHostPolicy()`.

### New: `HostRuntime` — live binding of a `Host` to a manager

- `host.withManager(manager, { apiKey, ...defaults })` returns a `HostRuntime`. `apiKey` lives on the runtime, not per-call.
- `HostRuntime.run(input, options?)`:
  - Snapshots the live `Host` on every call.
  - Validates required server ids against the manager (`assertHostServersKnown`).
  - Resolves the active tool set via `manager.getToolsForAiSdk(serverIds, { includeAppOnly: policy.respectToolVisibility === false })`.
  - Dynamically imports `HostRunner` and delegates execution.
- **Stateless across turns**: prior `PromptResult`s accumulate in `getPromptHistory()` for inspection but are NOT auto-replayed into the next turn. Multi-turn continuity stays explicit via `PromptOptions.context`.
- The `HostRuntimeManager` shape is structural (`hasServer` + `getToolsForAiSdk`); `MCPClientManager` satisfies it without a static dependency from the `host-config` bundle.
- `HostRuntime` lives in `sdk/src/host-config/` and stays browser-safe — the `HostRunner` import is dynamic, so bundlers can split it into a separate chunk.

### New: `host.run()` one-shot sugar

```ts
await host.run("write me a haiku", {
  apiKey: process.env.ANTHROPIC_API_KEY!,
  mcpClientManager,
});
```

Internally constructs a throwaway `HostRuntime` and delegates. No shared state across calls.

### New: `EvalTest` / `EvalSuite` stamp host-derived metadata

- When the executor implements `getHostSnapshot?.()`, `EvalTest` and `EvalSuite` derive a host metadata stamp (`buildHostSnapshotMetadata`) and additively merge it into each `EvalResultInput.metadata`. Existing keys (`retryCount`, `iterationNumber`, …) are never overwritten — conflicting host keys are namespaced under `host.<key>`.
- `MCPJamReportingConfig.host?: Host` field added. Wire-level `hostConfigHash` propagation is deferred to a follow-up stage; the field is accepted but not yet sent.

### Single-gated app-only filter + SDK-owned OpenAI-compat injection

- SEP-1865 `_meta.ui.visibility = ["app"]` filtering happens once at `HostRunner`'s tool-prep step, gated by `hostPolicy.respectToolVisibility !== false` (default = filter). The inline drop inside `convertToToolSet` is removed.
- The OpenAI Apps compat decision (`resolveOpenAiCompatForHostConfig`) is derived from the host snapshot by default and applied via the existing SDK `injectOpenAICompat` primitive on captured widget snapshots.

### Codemod for callers

```sh
sd 'TestAgent' 'HostRunner' $(rg -l 'TestAgent' sdk examples)
sd 'EvalAgent' 'HostExecutor' $(rg -l 'EvalAgent' sdk examples)
sd '\.prompt\(' '.run(' $(rg -l '\.prompt\(' sdk examples)
sd 'prompt: \(' 'run: (' $(rg -l 'prompt: \(' sdk examples)
```

(Object-literal mocks that wrote `prompt: async (...) => ...` need the same `prompt:` → `run:` rename; bare `prompt(` method declarations on interfaces likewise.)

### Inspector

No behavior changes. Imports of the Stage 3 helpers (`extractHostExecutionPolicy`, `applyVisibilityPolicyAndCountSignals`, `resolveOpenAiCompatForHostConfig`) move from the inspector's local re-export files to `@mcpjam/sdk/host-config/internal`. The inspector-only `host-execution-policy.ts` shim is deleted; `compat-runtime.ts` keeps only the Convex-bound `loadSuiteHostConfig`.
