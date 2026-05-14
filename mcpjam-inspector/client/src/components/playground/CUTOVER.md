# Playground Cutover Checklist

The Playground tab landed across 7 phases behind the `playground-tab-enabled`
PostHog flag. Phase 8 is the rollout + final decomposition. **It is gated on
dogfood evidence** — do not delete anything before staff has run with the flag
on for at least a week.

## What's complete

- `playground-tab-enabled` flag wired in `App.tsx` + sidebar; sidebar entry
  uses `PanelsTopLeft` icon. Chat and App Builder gain `hiddenByFlag` when the
  flag is on; `App.tsx` redirects `#chat-v2` / `#app-builder` to `#playground`.
- `playgroundViews` Convex table (`mcpjam-backend/convex/schema.ts`) +
  `playgroundViews.{list,get,create,update,remove,setDefault}` mutations.
- IDE shell in `client/src/components/playground/`:
  - `PlaygroundTab.tsx` — DndContext + left/center/right ResizablePanels,
    host-style provider stack.
  - `PlaygroundHeader.tsx` — view picker, dirty dot, Save / Save As / Rename /
    Delete / Set Default, HostPicker.
  - `panes/{SortablePane,PaneSlot,registry,ToolsPane,types}.tsx` — pane
    infrastructure. `tools` and `chatHistory` registered.
- `useViewState` + `ViewStateProvider` (`client/src/hooks/use-view-state.ts`)
  — in-memory payload with dirty tracking.
- `usePlaygroundViews` (`client/src/hooks/use-playground-views.ts`) — Convex
  bridge for view CRUD; auto-loads the user's default view on first authed
  query.
- `useAggregatedTools` (`client/src/hooks/use-aggregated-tools.ts`) — multi-
  server tool aggregation, exposes `(serverId, toolName)` tuples.
- `getToolsMetadata` collision fix
  (`client/src/lib/apis/mcp-tools-api.ts:179-219`) — adds `scopedMetadata`
  keyed by `${serverId}:${toolName}` and a `collidingToolNames` list. The
  bare-name `toolServerMap` is preserved for backward compat (last-seen-wins).
- Inspector command surface union extended to
  `"tools" | "app-builder" | "playground"`; `AppBuilderTab` accepts both
  during the flag period.
- Zod payload schema (`shared/playground-view.ts`) + `DEFAULT_PLAYGROUND_PAYLOAD`.

## What's deferred (the real cutover)

The Playground center pane currently mounts the legacy `AppBuilderTab`
wholesale. That keeps the flag-on experience behaviorally identical to App
Builder so dogfood doesn't risk regressions. The trade-offs that remain:

1. **`AppBuilderTab` decomposition.** Today: 1031 lines of orchestration that
   own state for tool selection, form values, execution, onboarding, and 5
   inspector command handlers. To replace the center pane with raw
   `<Thread/>` + `<ChatInput/>` plus a `ToolsPane` driven by `useViewState`,
   extract the orchestration into a `useAppBuilderState()` hook so both
   `AppBuilderTab` (for the old route) and `PlaygroundTab` can consume it.
2. **Switch default `leftPanes` to `["tools"]`** in
   `shared/playground-view.ts:DEFAULT_PLAYGROUND_PAYLOAD` once the new
   `ToolsPane` drives execution (today it's display-only, so we don't show it
   alongside AppBuilderTab's internal tools rail to avoid double UI).
3. **`evalChatHandoff` plumbing.** Chat Tab consumes
   `evalChatHandoff` (`App.tsx:2376`). `AppBuilderTab` doesn't accept it;
   wiring it requires the decomposition above.
4. **`chatHistory` pane.** Registered as a placeholder
   (`panes/registry.ts`); needs the existing `ChatHistoryRail`
   (`components/chat-v2/history/ChatHistoryRail.tsx`) ported across with all
   its session-coordination props.
5. **Multi-model controls in header.** `enableMultiModelChat` is currently
   passed in as a prop; the IDE-style toggle that lived in Chat Tab should
   move into `PlaygroundHeader`.
6. **`onUnload` / navigation guard.** Today saving is explicit but there is
   no confirm-on-leave modal when the view is dirty. Hook into
   `applyNavigation` in `App.tsx` to prompt.
7. **`useUIPlaygroundStore.selectedTool` → tuple.** Once the new `ToolsPane`
   becomes the source of truth, the store can carry `{ serverId, toolName }`
   instead of a bare string. Touches every consumer of `selectedTool`.

## Files to DELETE during the final cutover

Do not delete these until dogfood is green and the user has explicitly
approved:

- `client/src/components/ChatTabV2.tsx` (~2700 lines)
- `client/src/components/HostStyledChatTabV2.tsx`
- `client/src/components/ui-playground/AppBuilderTab.tsx` (~1031 lines)
- `client/src/components/ui-playground/PlaygroundLeft.tsx` — after
  `ToolsPane` fully covers its responsibilities.
- `client/src/components/ui-playground/PlaygroundMain.tsx` — after the IDE
  thread setup replaces it.
- `activeTab === "chat-v2"` / `activeTab === "app-builder"` branches in
  `App.tsx`.
- The `"app-builder"` alias in the `surface` union (`shared/inspector-command.ts`)
  — once consumers are confirmed to send `"playground"`.

## Rollout sequence

1. Land all Phase 1–7 commits behind the flag (default off). **DONE.**
2. Enable `playground-tab-enabled` for staff in PostHog.
3. Dogfood for ~1 week. Watch for regressions in tool execution, inspector
   commands, onboarding.
4. Do the decomposition work above (it's effectively Phase 4 part 2 — the
   plan compressed timeline-wise).
5. Enable GA in PostHog.
6. After 2 weeks of stable GA: delete the files above in one PR.
