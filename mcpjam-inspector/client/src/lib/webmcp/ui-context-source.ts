/**
 * Module publisher for the bits of app state the per-turn orientation block
 * wants but can't reach from the minimal agent hook.
 *
 * The agent hook (`use-mcpjam-agent-session`) is deliberately NOT a consumer
 * of `useSharedAppState` — it's a thin `useChat` wrapper. But the selected
 * servers live in that React context, and the orientation block reads best
 * with them ("you're on Connect, servers X and Y selected"). Same shape as
 * `router-ref.ts`: App.tsx, which already tracks the selection in refs,
 * publishes it here; the snapshot builder reads it at send time.
 *
 * Read-through only — the app-level `ui_snapshot_app` remains the
 * authoritative, richer source; this is the cheap always-present hint.
 */

let selectedServerNames: string[] = [];

/** Called by App.tsx when the selection changes. Names only, never ids. */
export function publishSelectedServerNames(names: string[]): void {
  selectedServerNames = names;
}

export function getSelectedServerNames(): string[] {
  return selectedServerNames;
}
