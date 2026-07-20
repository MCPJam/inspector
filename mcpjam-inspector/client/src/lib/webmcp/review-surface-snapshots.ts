/**
 * Pure snapshot builders for the read-only REVIEW surfaces (S9).
 *
 * These surfaces stay `agentTools: { kind: "none" }` — there is nothing for
 * the agent to operate — but each registers a snapshot provider so
 * `ui_snapshot_app` can OBSERVE the screen instead of returning `no_provider`.
 *
 * Keeping the shaping here (rather than inline in each component) does two
 * things: the surface component's bridge call stays a one-liner, and the
 * redaction + bounding contract is unit-testable without mounting the whole
 * screen. The transcript-safety rules from `ADDING_SURFACE_TOOLS.md` apply to
 * snapshots too: report STATE, not payloads; never secrets, tokens, or PII;
 * cap every list. Each builder reads ONLY the safe fields off its input, so a
 * caller that hands in a richer object (RPC payloads, task results, host
 * configs) still produces a redacted, bounded snapshot.
 */

/** Cap every enumerated list — a snapshot is orientation, not a data dump. */
export const REVIEW_SNAPSHOT_MAX_ITEMS = 30;

/** One traffic-log entry, as far as the snapshot is concerned. A real entry
 * also carries a `payload`; it is deliberately absent here so it can never be
 * read into the snapshot. */
export interface TraceLogEntryView {
  source: string;
  method: string;
  direction: string;
  serverId: string;
  serverName?: string;
  timestamp: string;
}

export interface TracingSnapshotInput {
  serverItems: ReadonlyArray<TraceLogEntryView>;
  appItems: ReadonlyArray<TraceLogEntryView>;
}

/**
 * Tracing: a summary of the recent turn/tool-call traffic — counts by source
 * and the most-recent entries by shape (method/direction/server/time). NEVER
 * the request/response bodies.
 */
export function buildTracingSnapshot(input: TracingSnapshotInput) {
  const combined = [...input.serverItems, ...input.appItems];
  const counts = { mcpServer: 0, mcpApps: 0, oauth: 0, other: 0 };
  for (const entry of combined) {
    if (entry.source === "mcp-server") counts.mcpServer += 1;
    else if (entry.source === "mcp-apps") counts.mcpApps += 1;
    else if (entry.source === "oauth") counts.oauth += 1;
    else counts.other += 1;
  }
  // Both slices are newest-first INDEPENDENTLY; concatenating and slicing would
  // report the first 30 server entries even when app traffic is newer. Sort the
  // merged stream by timestamp (ISO strings → epoch ms) so `recent` is globally
  // recent; an unparseable timestamp sorts oldest.
  const asMillis = (ts: string) => {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const recentEntries = [...combined].sort(
    (a, b) => asMillis(b.timestamp) - asMillis(a.timestamp),
  );
  return {
    totalItems: combined.length,
    counts,
    recent: recentEntries.slice(0, REVIEW_SNAPSHOT_MAX_ITEMS).map((entry) => ({
      source: entry.source,
      method: entry.method,
      direction: entry.direction,
      server: entry.serverName ?? entry.serverId,
      timestamp: entry.timestamp,
    })),
  };
}

export interface CompatibilitySnapshotInput {
  servers: ReadonlyArray<{ name: string }>;
  selectedServerName: string | null;
  showMatrix: boolean;
}

/**
 * Compatibility: which connected servers are on the matrix and which one's
 * report is open. The per-host capability findings are computed lazily below
 * the fold and are intentionally NOT recomputed here — that would be work, not
 * observation.
 */
export function buildCompatibilitySnapshot(input: CompatibilitySnapshotInput) {
  return {
    connectedServerCount: input.servers.length,
    servers: input.servers
      .slice(0, REVIEW_SNAPSHOT_MAX_ITEMS)
      .map((server) => server.name),
    selectedServer: input.selectedServerName,
    showMatrix: input.showMatrix,
  };
}

export interface HostCompareSnapshotInput {
  totalSelectableHosts: number;
  selectedHosts: ReadonlyArray<{ hostId: string; hostName: string | null }>;
  capabilityFields: ReadonlyArray<{ label: string }>;
  viewMode: string;
  searchQuery: string;
  supportFilter: string;
  /** The "Only show differences" toggle — an agent should see the same matrix. */
  divergingOnly: boolean;
  loadedSelectedCount: number;
  totalSelectedCount: number;
}

/**
 * Compare: which hosts are being compared side by side and which capability
 * rows the matrix is showing (labels only — never a host's resolved config).
 */
export function buildHostCompareSnapshot(input: HostCompareSnapshotInput) {
  return {
    totalSelectableHosts: input.totalSelectableHosts,
    comparedHostCount: input.totalSelectedCount,
    comparedHosts: input.selectedHosts
      .slice(0, REVIEW_SNAPSHOT_MAX_ITEMS)
      .map((host) => host.hostName),
    capabilityRowCount: input.capabilityFields.length,
    capabilityRows: input.capabilityFields
      .slice(0, REVIEW_SNAPSHOT_MAX_ITEMS)
      .map((field) => field.label),
    viewMode: input.viewMode,
    // Presence only — the raw field-search text is user input that can carry a
    // pasted secret or PII, and it lands in the chat transcript. Report that a
    // filter is active, never its contents.
    hasSearchQuery: Boolean(input.searchQuery && input.searchQuery.trim()),
    supportFilter: input.supportFilter,
    divergingOnly: input.divergingOnly,
    loadedSelectedCount: input.loadedSelectedCount,
  };
}

/** One caniuse permalink support row: a host and its support level. */
export interface CaniuseSupportRowView {
  hostName: string;
  supportLevel: string;
  supportLabel: string;
}

export interface CaniuseCapabilitySnapshotInput {
  capabilitySlug: string | null | undefined;
  capabilityLabel: string | null;
  rows: ReadonlyArray<CaniuseSupportRowView>;
}

/**
 * Compare (single-capability permalink): which capability is on screen and how
 * each preset host supports it. Backs the `host-compare` snapshot claim on the
 * `capabilities/:slug` deep-link route, where `CaniuseCapabilityPage` mounts
 * instead of the full compare view.
 */
export function buildCaniuseCapabilitySnapshot(
  input: CaniuseCapabilitySnapshotInput,
) {
  return {
    view: "capability-permalink",
    capabilitySlug: input.capabilitySlug ?? null,
    capability: input.capabilityLabel,
    hostCount: input.rows.length,
    hosts: input.rows.slice(0, REVIEW_SNAPSHOT_MAX_ITEMS).map((row) => ({
      host: row.hostName,
      support: row.supportLevel,
      label: row.supportLabel,
    })),
  };
}

export interface CiEvalsSnapshotInput {
  routeType: string;
  sidebarMode: string;
  selectedSuiteId: string | null;
  selectedSuiteName: string | null;
  selectedCommitSha: string | null;
  suites: ReadonlyArray<{
    name: string;
    source: string;
    latestResult: string | null;
  }>;
  commits: ReadonlyArray<{
    shortSha: string;
    branch: string | null;
    status: string;
    total: number;
    passed: number;
    failed: number;
    running: number;
  }>;
}

/**
 * CI Evals: the suites/commits the CI lens is showing and what's selected —
 * pass/fail COUNTS per commit and each suite's latest result. NEVER a test's
 * prompt, expected calls, or model output.
 */
export function buildCiEvalsSnapshot(input: CiEvalsSnapshotInput) {
  return {
    routeType: input.routeType,
    sidebarMode: input.sidebarMode,
    selectedSuiteId: input.selectedSuiteId,
    selectedSuiteName: input.selectedSuiteName,
    selectedCommitSha: input.selectedCommitSha,
    suiteCount: input.suites.length,
    suites: input.suites.slice(0, REVIEW_SNAPSHOT_MAX_ITEMS).map((suite) => ({
      name: suite.name,
      source: suite.source,
      latestResult: suite.latestResult,
    })),
    commitCount: input.commits.length,
    commits: input.commits
      .slice(0, REVIEW_SNAPSHOT_MAX_ITEMS)
      .map((commit) => ({
        shortSha: commit.shortSha,
        branch: commit.branch,
        status: commit.status,
        total: commit.total,
        passed: commit.passed,
        failed: commit.failed,
        running: commit.running,
      })),
  };
}

export interface TasksSnapshotInput {
  selectedServer: string | null;
  tasks: ReadonlyArray<{ taskId: string; status: string; createdAt: string }>;
  selectedTaskId: string | null;
  hasActiveTasks: boolean;
  autoRefresh: boolean;
}

/**
 * Tasks: the selected server's long-running tasks by id/status/created-time,
 * plus the selected task's progress fraction. NEVER a task's input, result, or
 * status message payload.
 */
export function buildTasksSnapshot(input: TasksSnapshotInput) {
  return {
    selectedServer: input.selectedServer,
    taskCount: input.tasks.length,
    hasActiveTasks: input.hasActiveTasks,
    autoRefresh: input.autoRefresh,
    tasks: input.tasks.slice(0, REVIEW_SNAPSHOT_MAX_ITEMS).map((task) => ({
      taskId: task.taskId,
      status: task.status,
      createdAt: task.createdAt,
    })),
    selectedTaskId: input.selectedTaskId,
    // No per-task progress: getLatestProgress is server-WIDE (keyed by
    // progressToken, which a Task object doesn't carry), so reporting it as the
    // selected task's progress would mis-attribute another task's fraction.
    // Omit until the progress API exposes task correlation.
  };
}
