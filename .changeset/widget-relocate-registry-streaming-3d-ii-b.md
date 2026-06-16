---
"@mcpjam/inspector": patch
---

Tier B Phase 3d-ii-b: relocate the app-tools registry + tool-input streaming
into `@mcpjam/widget-react`.

`app-tools-registry` (SEP-1865 App-Provided Tools registry — `useAppToolsRegistry`,
`recordAppToolInvocation`, the invocation log, attribution resolvers) and
`useToolInputStreaming` move into the package (they were already `@/`-free after
3b — only ext-apps/client/react/zustand + the `./widget-host` contract). The
inspector modules become re-export shims, so every import site is unchanged
(`use-chat-session`, `useToolExecution`, the modal/renderer, and the tests); the
registry's zustand store singleton lives in the package and is shared via the
re-export. Package gains `zustand` as a dep (externalized in tsup).

Second step of the renderer/cluster relocation (3d-ii). No behavior change.
