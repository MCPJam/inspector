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
 *   - how the pool is derived: `projects.autoConnectMode` (optional;
 *     normalized to 'all' at read time — this is what makes auto-connect
 *     on by default)
 *   - membership: `projects.serverIds` (optional array; normalized to []
 *     at read time). Under mode 'all' this is a materialized cache of the
 *     project's live catalog, not an independent list.
 *   - per-server header / timeout overrides: `projectServerRefs` table
 *     keyed by (projectId, serverId). INDEPENDENT of membership: a server
 *     can carry overrides while auto-connect is off, which is what makes
 *     the toggle non-destructive.
 *
 * Scenario/eval forks do NOT read this — they keep using the per-host
 * `serverIds` / `serverConnectionOverrides` snapshotted into their
 * pinned hostConfig at creation time. See the
 * "Project-scoped server connections" memory entry for the full
 * iterative-vs-fork split.
 */

import type { McpProtocolVersion } from "./client-config-v2";

/** Per-server connection override entry. Same shape as
 * `HostConfigInputV2.serverConnectionOverrides[serverId]` so a scenario
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
  /**
   * Per-server "never auto-connect this one". Honoured under every
   * `autoConnectMode`, including `all`, so one chronically broken or slow
   * server can be silenced without turning auto-connect off for the whole
   * project.
   *
   * Unlike the fields above this changes MEMBERSHIP rather than connection
   * settings: the backend subtracts opted-out servers from the pool and
   * never fans the flag out to a host config.
   */
  autoConnectDisabled?: boolean;
};

/**
 * How the project's auto-connect pool is derived.
 *
 *   all      — every live server in the project. A newly created server is
 *              enrolled by definition, so `serverIds` is advisory on write:
 *              the backend re-resolves the catalog.
 *   none     — auto-connect off. Overrides survive.
 *   selected — `serverIds` is a hand-picked list.
 */
export type ProjectAutoConnectMode = "all" | "none" | "selected";

/** Write payload for `ensureProjectServerConfig`. `overrides` is keyed by
 * serverId; entries for servers that are not live members of the project
 * are rejected by the backend, but an override for a live server OUTSIDE
 * `serverIds` is fine — configuration and enrollment are separate.
 *
 * Omitting `autoConnectMode` is a legacy write: the backend classifies it
 * from the array (empty → none, whole catalog → all, else selected). New
 * call sites should pass it explicitly. */
export type ProjectServerConfigInput = {
  serverIds: string[];
  overrides: Record<string, ProjectServerOverrideEntry>;
  autoConnectMode?: ProjectAutoConnectMode;
};

/** Read shape returned by `getProjectServerConfig`. Identical to the
 * input plus the projectId stamped on so callers can key caches by
 * project without an extra round trip. `autoConnectMode` is always
 * concrete on a read, even for a project with no stored field. */
export type ProjectServerConfigDto = ProjectServerConfigInput & {
  projectId: string;
  autoConnectMode: ProjectAutoConnectMode;
};

/** Empty / "no servers configured yet" default. Use as the seed value
 * for new project drafts before any save has happened. */
export const emptyProjectServerConfigInput = (): ProjectServerConfigInput => ({
  serverIds: [],
  overrides: {},
});

/**
 * @deprecated The implicit enrollment this recorded no longer happens.
 *
 * It existed for one reason: the backend used to reject an override key
 * that was not a member of `serverIds`, so pinning a protocol version on a
 * server that wasn't auto-connected meant quietly enrolling it — and this
 * record was how clearing the pin could un-enroll it again without
 * disturbing servers the user had genuinely chosen.
 *
 * Overrides are now validated against the project's live catalog rather
 * than the pool, so a pin no longer touches enrollment at all. Keeping the
 * workaround would be worse than useless: under `autoConnectMode: 'none'`,
 * enrolling one server to save a pin would classify the write as
 * `'selected'` and switch auto-connect back ON for it.
 *
 * The type stays exported only so `ServerDetailModal`'s cache prop keeps
 * its shape through this change; both go away with the next cleanup.
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
 * preserved verbatim, and an entry that collapses to nothing is dropped
 * (mirrors backend `normalizeOverrideEntry`).
 *
 * Saving a pin NEVER changes enrollment. It used to have to: the backend
 * rejected an override key outside `serverIds`, so a pin on a server that
 * wasn't auto-connected quietly enrolled it. Overrides are now validated
 * against the project's live catalog instead, so `serverIds` and the mode
 * pass through untouched — which matters most for a project with
 * auto-connect OFF, where the old behaviour would have switched it back on
 * for that server.
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

  // Enrollment is carried through verbatim — a protocol pin is a
  // configuration change, not a request to auto-connect anything. Passing
  // the mode explicitly matters: without it the backend would re-classify
  // this write from the array alone, and a project whose user has selected
  // every server would silently become 'all'.
  await setConfig({
    projectId,
    input: {
      serverIds: currentServerIds,
      overrides: nextOverrides,
      ...(current?.autoConnectMode
        ? { autoConnectMode: current.autoConnectMode }
        : {}),
    },
  });

  // Clear any provenance left by the old implicit-enrollment behaviour so
  // a session that straddles the change doesn't keep a stale marker.
  const autoEnrollKey = getProtocolOverrideAutoEnrollKey(projectId, serverId);
  autoEnrollCache?.delete(autoEnrollKey);
  removeProtocolOverrideAutoEnrollRecord(autoEnrollKey);
}
