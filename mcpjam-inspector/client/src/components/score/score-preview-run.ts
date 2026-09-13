import type { ScoreSuiteSummary, StoredScoreRun } from "@/lib/apis/score-api";
import { SCORE_PREVIEW_RESULT_TOKEN } from "./score-design-walkthrough";

/** Matches the Paper landing card's run date, with a wall-clock time. */
export const SCORE_PREVIEW_CREATED_AT = Date.parse("2026-08-26T21:32:12.000Z");

export function isScorePreviewResultToken(
  token: string | undefined,
): boolean {
  return token === SCORE_PREVIEW_RESULT_TOKEN;
}

function suite(
  suiteId: ScoreSuiteSummary["suiteId"],
  summary: Omit<ScoreSuiteSummary, "suiteId">,
): ScoreSuiteSummary {
  return { suiteId, ...summary };
}

/**
 * Local dummy stored run for `/results/preview`. Enough of every check
 * state (pass, fail, advisory, pending, skip) to iterate the report.
 */
export function scorePreviewRun(): StoredScoreRun {
  const protocol = suite("protocol", {
    score: 77,
    outcome: "incomplete",
    applicable: 18,
    passed: 14,
    failed: 2,
    couldNotRun: 1,
    notApplicable: 8,
    advisoryCount: 1,
    protocolVersion: "2025-11-25",
  });
  const apps = suite("apps", {
    score: 100,
    outcome: "passed",
    applicable: 12,
    passed: 12,
    failed: 0,
    couldNotRun: 0,
    notApplicable: 4,
    advisoryCount: 0,
  });
  const tasks = suite("tasks", {
    score: 75,
    outcome: "failed",
    applicable: 16,
    passed: 12,
    failed: 4,
    couldNotRun: 0,
    notApplicable: 6,
    advisoryCount: 0,
  });
  const oauth = suite("oauth", {
    score: 100,
    outcome: "passed",
    applicable: 10,
    passed: 10,
    failed: 0,
    couldNotRun: 0,
    notApplicable: 12,
    advisoryCount: 0,
  });

  return {
    serverUrl: "https://mcp.monday.com/mcp",
    score: 84,
    outcome: "failed",
    applicable: 56,
    passed: 48,
    failed: 6,
    couldNotRun: 1,
    notApplicable: 30,
    advisoryCount: 1,
    protocolVersion: "2025-11-25",
    createdAt: SCORE_PREVIEW_CREATED_AT,
    suiteSummaries: [protocol, apps, tasks, oauth],
    report: {
      protocol: {
        checks: [
          { id: "initialize", title: "Server Initialize", status: "passed" },
          { id: "ping", title: "Ping", status: "passed" },
          {
            id: "capabilities",
            title: "Capabilities Consistent",
            status: "passed",
          },
          { id: "tools-list", title: "Tools List", status: "passed" },
          {
            id: "tool-schemas",
            title: "Tool Input Schemas Valid",
            status: "failed",
            error: { message: "board_items is missing required properties" },
          },
          { id: "prompts-list", title: "Prompts List", status: "passed" },
          { id: "resources-list", title: "Resources List", status: "passed" },
          {
            id: "logging-set-level",
            title: "Logging Set Level",
            status: "skipped",
            skipReason: "Server does not advertise the optional logging capability",
          },
          {
            id: "wire-schema-valid",
            title: "Wire schema is valid",
            status: "failed",
            error: { message: "schema mismatch on tools/call" },
          },
        ],
        profile: {
          pendingCheckIds: ["wire-schema-valid"],
        },
      } as StoredScoreRun["report"]["protocol"],
      apps: {
        checks: [
          { id: "app-connect", title: "App Connect", status: "passed" },
          { id: "tool-call", title: "Tool Call Roundtrip", status: "passed" },
          { id: "resource-read", title: "Resource Read", status: "passed" },
        ],
      } as StoredScoreRun["report"]["apps"],
      tasks: {
        checks: [
          { id: "create-item", title: "Create Item", status: "passed" },
          { id: "update-item", title: "Update Item", status: "passed" },
          {
            id: "query-board",
            title: "Query Board",
            status: "failed",
            error: { message: "Timed out waiting for board items" },
          },
          {
            id: "delete-item",
            title: "Delete Item",
            status: "failed",
            error: { message: "Delete returned 403" },
          },
        ],
      } as StoredScoreRun["report"]["tasks"],
      oauth: {
        steps: [
          { id: "discover", title: "Authorization Server Discovery", status: "passed" },
          { id: "register", title: "Dynamic Client Registration", status: "passed" },
          { id: "authorize", title: "Authorization Code Exchange", status: "passed" },
          {
            id: "refresh",
            title: "Refresh Token",
            status: "skipped",
            skipReason: "Server did not issue a refresh token",
          },
        ],
      } as StoredScoreRun["report"]["oauth"],
    },
  };
}
