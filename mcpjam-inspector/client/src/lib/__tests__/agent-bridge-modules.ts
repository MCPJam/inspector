/**
 * Test fixture, hand-maintained: surfaceId → the repo-relative module that
 * calls `useSurfaceAgentBridge({ surfaceId: "<id>", ... })` for that surface.
 *
 * Shared by `agent-tool-coverage.test.ts` (every group surface must have a
 * bridge call in its OWN component — never a shared hook) and
 * `surface-snapshot-coverage.test.ts` (a bridge module is the second valid
 * convention for `hasSnapshotProvider`).
 *
 * A row is the component that OWNS the surface — the one whose mount is the
 * surface being on screen.
 */
export const BRIDGE_MODULES: Record<string, string> = {
  registry: "client/src/components/RegistryTab.tsx",
};
