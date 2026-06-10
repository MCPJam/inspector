/**
 * Frontend types for project-scoped server configuration.
 *
 * Mirrors `mcpjam-backend/convex/lib/projectServerConfig.ts` (kept in
 * sync by hand, same as `client-config-v2.ts` mirrors `hostConfigV2.ts`).
 *
 * Phase 1 (additive): the types exist so the inspector can typecheck
 * future call sites. P4 will swap auto-connect + the lifted Servers
 * section to read this DTO.
 *
 * Storage on the backend:
 *   - membership: `projects.serverIds` (optional array; normalized to []
 *     at read time)
 *   - per-server header / timeout overrides: `projectServerRefs` table
 *     keyed by (projectId, serverId)
 *
 * Chatbox/eval forks do NOT read this — they keep using the per-host
 * `serverIds` / `serverConnectionOverrides` snapshotted into their
 * pinned hostConfig at creation time. See the
 * "Project-scoped server connections" memory entry for the full
 * iterative-vs-fork split.
 */

import type { McpProtocolVersionPin } from "./client-config-v2";

/** Per-server connection override entry. Same shape as
 * `HostConfigInputV2.serverConnectionOverrides[serverId]` so a chatbox
 * fork can snapshot the project's overrides into its hostConfig without
 * re-shaping. */
export type ProjectServerOverrideEntry = {
  headersOverride?: Record<string, string>;
  requestTimeoutOverride?: number;
  /**
   * Per-server outbound MCP wire mode override (control plane). Mirror
   * of `projectServerRefs.mcpProtocolVersionOverride` on the backend. Fanned
   * out to the execution-plane `hostConfigsV2.serverConnectionOverrides`
   * at write time so the wire-client factory never reads the project
   * layer.
   */
  mcpProtocolVersionOverride?: McpProtocolVersionPin;
};

/** Write payload for `ensureProjectServerConfig`. `overrides` is keyed
 * by serverId; entries for ids not in `serverIds` are rejected by the
 * backend. */
export type ProjectServerConfigInput = {
  serverIds: string[];
  overrides: Record<string, ProjectServerOverrideEntry>;
};

/** Read shape returned by `getProjectServerConfig`. Identical to the
 * input plus the projectId stamped on so callers can key caches by
 * project without an extra round trip. */
export type ProjectServerConfigDto = ProjectServerConfigInput & {
  projectId: string;
};

/** Empty / "no servers configured yet" default. Use as the seed value
 * for new project drafts before any save has happened. */
export const emptyProjectServerConfigInput = (): ProjectServerConfigInput => ({
  serverIds: [],
  overrides: {},
});
