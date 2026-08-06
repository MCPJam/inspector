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

import type { McpProtocolVersion } from "./client-config-v2";

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
  mcpProtocolVersionOverride?: McpProtocolVersion;
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

/**
 * Provenance marker for a server that was enrolled in `serverIds` ONLY so a
 * `mcpProtocolVersionOverride` could be saved (backend validation requires
 * override keys to be members of `serverIds`). Remembered so clearing the
 * pin can undo the implicit enrollment without removing servers that were
 * already explicitly auto-connected.
 */
export type ProtocolOverrideAutoEnrollRecord = {
  previousServerIds: string[];
};

const PROTOCOL_OVERRIDE_AUTO_ENROLL_STORAGE_PREFIX =
  "mcpjam:protocol-override-auto-enroll";

export const getProtocolOverrideAutoEnrollKey = (
  projectId: string,
  serverId: string,
) => `${PROTOCOL_OVERRIDE_AUTO_ENROLL_STORAGE_PREFIX}:${projectId}:${serverId}`;

export const readProtocolOverrideAutoEnrollRecord = (
  key: string,
): ProtocolOverrideAutoEnrollRecord | undefined => {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<ProtocolOverrideAutoEnrollRecord>;
    if (!Array.isArray(parsed.previousServerIds)) return undefined;
    return {
      previousServerIds: parsed.previousServerIds.filter(
        (id): id is string => typeof id === "string",
      ),
    };
  } catch {
    return undefined;
  }
};

export const writeProtocolOverrideAutoEnrollRecord = (
  key: string,
  record: ProtocolOverrideAutoEnrollRecord,
) => {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(record));
  } catch {
    // Losing this marker only affects cleanup of an implicit enrollment.
  }
};

export const removeProtocolOverrideAutoEnrollRecord = (key: string) => {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Best-effort cleanup only.
  }
};

export const matchesImplicitAutoEnrollment = (
  currentServerIds: string[],
  serverId: string,
  previousServerIds: string[],
) => {
  const previousServerIdSet = new Set(previousServerIds);
  if (previousServerIdSet.has(serverId)) return false;
  if (!currentServerIds.includes(serverId)) return false;
  if (currentServerIds.length !== previousServerIdSet.size + 1) return false;
  return currentServerIds.every(
    (currentServerId) =>
      currentServerId === serverId || previousServerIdSet.has(currentServerId),
  );
};

/**
 * Splice one server's `mcpProtocolVersionOverride` into the project's
 * `(serverIds, overrides)` pair and write it back through `setConfig`.
 *
 * `setConfig` REPLACES the whole pair on the backend, so callers must pass
 * the current hydrated DTO (`null` is the genuine "no row yet" baseline;
 * a still-loading `undefined` must be handled by the caller BEFORE calling
 * this — defaulting it here would wipe the project's membership list and
 * every other server's overrides). Every other server's overrides are
 * preserved verbatim, an entry that collapses to nothing is dropped
 * (mirrors backend `normalizeOverrideEntry`), and implicit enrollment /
 * un-enrollment provenance is tracked via sessionStorage plus the optional
 * in-memory `autoEnrollCache`.
 */
export async function applyMcpProtocolVersionOverride({
  projectId,
  serverId,
  current,
  next,
  setConfig,
  autoEnrollCache,
}: {
  projectId: string;
  serverId: string;
  current: ProjectServerConfigDto | null;
  next: McpProtocolVersion | undefined;
  setConfig: (args: {
    projectId: string;
    input: ProjectServerConfigInput;
  }) => Promise<unknown>;
  autoEnrollCache?: Map<string, ProtocolOverrideAutoEnrollRecord>;
}): Promise<void> {
  const currentServerIds = current?.serverIds ?? [];
  const currentOverrides = current?.overrides ?? {};
  const existingEntry = currentOverrides[serverId] ?? {};
  const updatedEntry: ProjectServerOverrideEntry = {
    ...existingEntry,
    mcpProtocolVersionOverride: next,
  };
  const hasContent =
    (updatedEntry.headersOverride &&
      Object.keys(updatedEntry.headersOverride).length > 0) ||
    updatedEntry.requestTimeoutOverride !== undefined ||
    updatedEntry.mcpProtocolVersionOverride !== undefined;
  const nextOverrides: Record<string, ProjectServerOverrideEntry> = {
    ...currentOverrides,
  };
  if (hasContent) nextOverrides[serverId] = updatedEntry;
  else delete nextOverrides[serverId];
  const autoEnrollKey = getProtocolOverrideAutoEnrollKey(projectId, serverId);
  const autoEnrollRecord =
    autoEnrollCache?.get(autoEnrollKey) ??
    readProtocolOverrideAutoEnrollRecord(autoEnrollKey);
  const shouldAutoEnrollForOverride =
    hasContent && !currentServerIds.includes(serverId);
  const shouldUndoAutoEnroll =
    !hasContent &&
    autoEnrollRecord !== undefined &&
    matchesImplicitAutoEnrollment(
      currentServerIds,
      serverId,
      autoEnrollRecord.previousServerIds,
    );
  const nextServerIds = shouldAutoEnrollForOverride
    ? [...currentServerIds, serverId]
    : shouldUndoAutoEnroll
      ? currentServerIds.filter(
          (currentServerId) => currentServerId !== serverId,
        )
      : currentServerIds;
  await setConfig({
    projectId,
    input: { serverIds: nextServerIds, overrides: nextOverrides },
  });
  if (shouldAutoEnrollForOverride) {
    const nextAutoEnrollRecord = {
      previousServerIds: [...currentServerIds],
    };
    autoEnrollCache?.set(autoEnrollKey, nextAutoEnrollRecord);
    writeProtocolOverrideAutoEnrollRecord(autoEnrollKey, nextAutoEnrollRecord);
  } else if (!hasContent && autoEnrollRecord !== undefined) {
    autoEnrollCache?.delete(autoEnrollKey);
    removeProtocolOverrideAutoEnrollRecord(autoEnrollKey);
  }
}
