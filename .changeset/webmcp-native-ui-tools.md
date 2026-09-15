---
"@mcpjam/inspector": patch
---

Publish MCPJam's own inspector tools to browser-native WebMCP agents.

The `ui_*` catalog — navigate, select a server, prefill and run a tool in the
playground — was reachable only through Ask MCPJam. The same tools are now also
registered on `document.modelContext` (with the deprecated
`navigator.modelContext` as a capability-checked fallback), so a browser agent
discovers and drives the inspector without anyone opening the side panel.

One catalog, one execution path. `ui-tool-execution.ts` resolves the name
against the registry, validates the arguments, runs the registered handler and
returns a bounded, JSON-serializable result — for both agents, so neither can
grow a second answer to what a tool does. Everything that only exists because
there is a conversation stays in the Ask MCPJam adapter: the approval pill, the
transcript, duplicate-call suppression, the side-panel handoff. A native call
creates no conversation and opens no panel.

- **Eligibility is explicit, per definition.** `nativePublication` says
  publish or internal-with-a-reason, and an absent decision reads as internal,
  so a new tool is never published by accident. `ui_ask_user` and the scoped
  eval-authoring tools stay internal: each needs an MCPJam conversation that a
  native call does not have.
- **Each agent owns its approvals.** Ask MCPJam keeps its Tool Approval
  setting; an external agent's browser runs its own confirmation, informed by
  the hints Chrome's secure-tools guidance asks for — `readOnlyHint`, an
  explicit `untrustedContentHint` for results that quote a third party, and
  `consequentialHint` for destructive or externally-reaching actions. Both
  still pass through MCPJam's own billing gates and in-app confirmations,
  because both run the same handler. Tools are never exposed to other origins.
- **Built around what the pinned Chromium actually does.** A duplicate name is
  rejected, so work for one name is serialized: retire, wait for the platform,
  re-register. Unregistering during a call is only safe for in-flight
  executions from Chrome 153, so a registration with an accepted call stays
  standing until that call settles — marked dead meanwhile, so anything new
  through it is refused.

Browser support remains a prerequisite: WebMCP ships behind an origin trial, so
where the API is absent nothing is published and MCPJam's own agent is
unaffected. The Playground still receives no automatic `uiTools` snapshot, and
the standalone scenario chat publishes nothing at all. See
`mcpjam-inspector/docs/webmcp-native-tools.md`.
