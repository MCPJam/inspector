/**
 * Test fixture, hand-maintained: surfaceId → the repo-relative module that
 * calls `useSurfaceAgentBridge({ surfaceId: "<id>", ... })` for that surface.
 *
 * Shared by `agent-tool-coverage.test.ts` (every group surface must have a
 * bridge call in its OWN component — never a shared hook) and
 * `surface-snapshot-coverage.test.ts` (a bridge module is the second valid
 * convention for `hasSnapshotProvider`).
 *
 * Empty today: the map's structure and assertions are ready, and the first
 * row lands with the first surface tool group.
 */
export const BRIDGE_MODULES: Record<string, string> = {};
