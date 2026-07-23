/**
 * Redaction + bounding contract for the S9 review-surface snapshot builders.
 *
 * Transcript safety (ADDING_SURFACE_TOOLS.md) applies to snapshots: they land
 * in the chat transcript and cross to the server, so they must carry STATE, not
 * payloads — no secrets, tokens, or PII, and every list capped. Each builder
 * reads only its declared safe fields, so we hand it inputs whose EXCLUDED
 * fields (RPC payloads, task results, host configs, status messages) carry an
 * obvious secret marker and assert the serialized snapshot never contains it —
 * then assert the enumerated lists are capped at 30.
 */
import { describe, expect, it } from "vitest";
import {
  REVIEW_SNAPSHOT_MAX_ITEMS,
  buildCaniuseCapabilitySnapshot,
  buildCiEvalsSnapshot,
  buildCompatibilitySnapshot,
  buildHostCompareSnapshot,
  buildTasksSnapshot,
  buildTracingSnapshot,
} from "../review-surface-snapshots";

const SECRET = "SECRET_never_in_a_snapshot_sk-1234567890";

/** Substrings that must never appear in a serialized snapshot. */
function expectNoSecrets(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(SECRET);
  expect(serialized.toLowerCase()).not.toContain("password");
}

describe("review-surface snapshots redact and bound", () => {
  it("tracing: summarizes traffic by shape, never the payloads", () => {
    // Each entry carries a secret `payload` the builder must ignore.
    const serverItems = Array.from({ length: 50 }, (_, i) => ({
      source: i % 2 === 0 ? "mcp-server" : "oauth",
      method: "tools/call",
      direction: "SEND",
      serverId: `srv-${i}`,
      serverName: `Server ${i}`,
      timestamp: "2026-07-18T00:00:00Z",
      payload: { token: SECRET, password: SECRET },
    }));
    const appItems = [
      {
        source: "mcp-apps",
        method: "render",
        direction: "HOST→UI",
        serverId: "srv-app",
        timestamp: "2026-07-18T00:00:00Z",
        message: SECRET,
      },
    ];

    const snapshot = buildTracingSnapshot({ serverItems, appItems });
    expectNoSecrets(snapshot);
    expect(snapshot.totalItems).toBe(51);
    expect(snapshot.recent).toHaveLength(REVIEW_SNAPSHOT_MAX_ITEMS);
    expect(snapshot.counts.mcpServer).toBe(25);
    expect(snapshot.counts.oauth).toBe(25);
    expect(snapshot.counts.mcpApps).toBe(1);
    // Shape only — no payload/message key leaks through.
    expect(Object.keys(snapshot.recent[0])).toEqual([
      "source",
      "method",
      "direction",
      "server",
      "timestamp",
    ]);
  });

  it("compatibility: reports server names + selection, caps the list", () => {
    const servers = Array.from({ length: 45 }, (_, i) => ({
      name: `Server ${i}`,
      // A server's full config would carry secrets; the builder never reads it.
      config: { headers: { Authorization: SECRET } },
    }));
    const snapshot = buildCompatibilitySnapshot({
      servers,
      selectedServerName: "Server 3",
      showMatrix: true,
    });
    expectNoSecrets(snapshot);
    expect(snapshot.connectedServerCount).toBe(45);
    expect(snapshot.servers).toHaveLength(REVIEW_SNAPSHOT_MAX_ITEMS);
    expect(snapshot.selectedServer).toBe("Server 3");
  });

  it("host-compare: reports host names + capability labels, never configs", () => {
    const selectedHosts = Array.from({ length: 40 }, (_, i) => ({
      hostId: `h-${i}`,
      hostName: `Host ${i}`,
      config: { apiKey: SECRET },
    }));
    const capabilityFields = Array.from({ length: 40 }, (_, i) => ({
      label: `Capability ${i}`,
      description: SECRET,
    }));
    const snapshot = buildHostCompareSnapshot({
      totalSelectableHosts: 60,
      selectedHosts,
      capabilityFields,
      viewMode: "table",
      searchQuery: "paste-of-a-secret-token",
      supportFilter: "all",
      divergingOnly: true,
      loadedSelectedCount: 40,
      totalSelectedCount: 40,
    });
    expectNoSecrets(snapshot);
    expect(snapshot.comparedHosts).toHaveLength(REVIEW_SNAPSHOT_MAX_ITEMS);
    expect(snapshot.capabilityRows).toHaveLength(REVIEW_SNAPSHOT_MAX_ITEMS);
    expect(snapshot.comparedHostCount).toBe(40);
    expect(snapshot.capabilityRowCount).toBe(40);
    // The "Only show differences" toggle is reflected so the agent's view
    // matches the matrix.
    expect(snapshot.divergingOnly).toBe(true);
    // The raw field-search text is user input — presence only, never echoed.
    expect(snapshot).not.toHaveProperty("searchQuery");
    expect(snapshot.hasSearchQuery).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("paste-of-a-secret-token");
  });

  it("host-compare (permalink): reports support levels, never configs", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      hostName: `Host ${i}`,
      supportLevel: "full",
      supportLabel: "Full support",
      config: { secret: SECRET },
    }));
    const snapshot = buildCaniuseCapabilitySnapshot({
      capabilitySlug: "elicitation",
      capabilityLabel: "Elicitation",
      rows,
    });
    expectNoSecrets(snapshot);
    expect(snapshot.capability).toBe("Elicitation");
    expect(snapshot.hosts).toHaveLength(REVIEW_SNAPSHOT_MAX_ITEMS);
    expect(snapshot.hostCount).toBe(40);
  });

  it("ci-evals: reports suites/commits + pass counts, never test prompts", () => {
    const suites = Array.from({ length: 45 }, (_, i) => ({
      name: `Suite ${i}`,
      source: "sdk",
      latestResult: "passed",
      // A run's iterations carry prompts/outputs; the builder never reads them.
      iterations: [{ prompt: SECRET, output: SECRET }],
    }));
    const commits = Array.from({ length: 45 }, (_, i) => ({
      shortSha: `abc12${i}`,
      branch: "main",
      status: "passed",
      total: 2,
      passed: 2,
      failed: 0,
      running: 0,
      runs: [{ notes: SECRET }],
    }));
    const snapshot = buildCiEvalsSnapshot({
      routeType: "list",
      sidebarMode: "runs",
      selectedSuiteId: null,
      selectedSuiteName: null,
      selectedCommitSha: null,
      suites,
      commits,
    });
    expectNoSecrets(snapshot);
    expect(snapshot.suites).toHaveLength(REVIEW_SNAPSHOT_MAX_ITEMS);
    expect(snapshot.commits).toHaveLength(REVIEW_SNAPSHOT_MAX_ITEMS);
    expect(snapshot.suiteCount).toBe(45);
    expect(snapshot.commitCount).toBe(45);
    expect(Object.keys(snapshot.suites[0])).toEqual([
      "name",
      "source",
      "latestResult",
    ]);
  });

  it("tasks: reports id/status, never task payloads or mis-attributed progress", () => {
    const tasks = Array.from({ length: 45 }, (_, i) => ({
      taskId: `task-${i}`,
      status: "working",
      createdAt: "2026-07-18T00:00:00Z",
      // Payload-ish fields the builder must not read.
      statusMessage: SECRET,
      result: { content: SECRET },
    }));
    const snapshot = buildTasksSnapshot({
      selectedServer: "srv-1",
      tasks,
      selectedTaskId: "task-0",
      hasActiveTasks: true,
      autoRefresh: true,
    });
    expectNoSecrets(snapshot);
    expect(snapshot.taskCount).toBe(45);
    expect(snapshot.tasks).toHaveLength(REVIEW_SNAPSHOT_MAX_ITEMS);
    // Server-wide progress can't be attributed to the selected task, so it's
    // omitted rather than mis-reported.
    expect(snapshot).not.toHaveProperty("selectedProgress");
    expect(Object.keys(snapshot.tasks[0])).toEqual([
      "taskId",
      "status",
      "createdAt",
    ]);
  });

  it("tracing: `recent` is globally newest-first across server AND app items", () => {
    // Server items are OLDER; a single app item is the newest. A naive
    // concat-then-slice would bury the app item behind the server run.
    const serverItems = Array.from({ length: 40 }, (_, i) => ({
      source: "mcp-server" as const,
      method: "tools/call",
      direction: "SEND",
      serverId: `srv-${i}`,
      serverName: `Server ${i}`,
      timestamp: "2026-07-18T00:00:00Z",
    }));
    const appItems = [
      {
        source: "mcp-apps" as const,
        method: "render",
        direction: "HOST→UI",
        serverId: "srv-app",
        serverName: "App",
        timestamp: "2026-07-19T12:00:00Z", // newest
      },
    ];
    const snapshot = buildTracingSnapshot({ serverItems, appItems });
    expect(snapshot.recent[0]?.source).toBe("mcp-apps");
    expect(snapshot.recent[0]?.timestamp).toBe("2026-07-19T12:00:00Z");
  });
});
