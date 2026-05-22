---
"@mcpjam/inspector": patch
---

### `@mcpjam/inspector`
- **Drop the legacy `openaiAppViews:remove` delete hook from `ViewsTab`**: after the Phase B backfill, all saved views live in `mcpAppViews`, so `useViewMutations` no longer needs to expose `removeOpenaiView` and `ViewsTab.handleDelete` no longer needs to branch on `view.protocol`. Deletion always routes through `removeMcpView({ viewId })`. The `openaiAppViews:remove` Convex mutation itself is being dropped in the backend's Phase C2 cleanup; this commit removes the inspector-side caller in advance so that drop is a no-op for this repo.
- Test-side mock for `removeOpenaiView` removed from `ViewsTab.layout.test.tsx`; `useDeleteView` dep array slimmed accordingly.
