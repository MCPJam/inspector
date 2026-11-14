/**
 * Sample test plan data for the Readiness page's test plan section: a plan
 * with a read, a write that creates a fixture and a destructive call that
 * runs last, its issues, a run's results with a call in doubt, and drafts.
 */
import { vi } from "vitest";
import {
  DIRECTORY_TEST_CASE_STATUSES,
  type DirectoryTestCaseStatus,
  type DirectoryTestPlan,
  type DirectoryTestPlanIssue,
} from "@mcpjam/sdk/browser";
import type { PlatformDirectoryTestArgumentDrafting } from "@mcpjam/sdk/platform";
import type { DirectoryTestPlanSession } from "@/hooks/use-directory-test-plan";
import type { ToolTests } from "@/lib/apis/directory-test-plan-api";

const ref = { $fixture: "note", value: "id" };

export const PLAN: DirectoryTestPlan = {
  schemaVersion: 1,
  fixtures: [
    {
      id: "note",
      description: "A note the plan creates and removes",
      origin: "created",
      capture: { id: "note.id" },
    },
  ],
  tools: [
    {
      tool: "search_docs",
      effect: "read",
      openWorld: false,
      action: "run",
      writes: [],
    },
    {
      tool: "list_projects",
      effect: "read",
      openWorld: true,
      action: "excluded",
      exclusion: { reason: "costly" },
      writes: [],
    },
    {
      tool: "create_note",
      effect: "write",
      openWorld: false,
      action: "run",
      writes: ["note"],
    },
    {
      tool: "delete_note",
      effect: "destructive",
      openWorld: false,
      action: "run",
      writes: ["note"],
    },
  ],
  cases: [
    {
      id: "create_note#valid",
      tool: "create_note",
      kind: "valid",
      creates: ["note"],
    },
    {
      id: "search_docs#valid",
      tool: "search_docs",
      kind: "valid",
      arguments: { query: "pricing" },
    },
    {
      id: "search_docs#missing-arguments",
      tool: "search_docs",
      kind: "negative",
      arguments: {},
      expectation: "The tool refuses a call without its required arguments.",
    },
    {
      id: "delete_note#valid",
      tool: "delete_note",
      kind: "valid",
      arguments: { id: ref },
    },
  ],
  budget: { maxCalls: 4, concurrency: 1, callTimeoutMs: 30_000 },
  cleanup: [{ fixture: "note", tool: "delete_note", arguments: { id: ref } }],
};

export const ISSUES: DirectoryTestPlanIssue[] = [
  {
    code: "argumentsMissing",
    message:
      "Case create_note#valid has no arguments yet. Draft or enter them.",
    caseId: "create_note#valid",
  },
  {
    code: "missingTool",
    message:
      "archive_note is not in the plan. Add a case for it, or exclude it with a reason.",
    tool: "archive_note",
  },
];

const NOW = Date.now();
export const CATALOG = { revisionNumber: 7, capturedAt: NOW - 3 * 3600_000 };

export function savedPlan(revision = 3, plan = PLAN) {
  return {
    submissionId: "sub_1",
    revision,
    counts: { tools: 4, cases: 4, fixtures: 1, cleanup: 1 },
    savedBy: "user_1",
    savedAt: NOW - 2 * 3600_000,
    plan,
    issues: [],
    catalog: CATALOG,
  };
}

/** A session as `useDirectoryTestPlan` returns it; `plan` follows `edited` and `saved`. */
export function planSession(
  overrides: Partial<DirectoryTestPlanSession> = {},
): DirectoryTestPlanSession {
  const state = {
    saved: savedPlan(),
    edited: null,
    base: 3,
    issues: [],
    catalog: CATALOG,
    busy: null,
    error: null,
    conflict: null,
    results: null,
    resultsError: null,
    draft: vi.fn(),
    save: vi.fn(),
    edit: vi.fn(),
    discard: vi.fn(),
    ...overrides,
  };
  return { plan: state.edited ?? state.saved?.plan ?? null, ...state };
}

function counts(given: Partial<Record<DirectoryTestCaseStatus, number>>) {
  return Object.fromEntries(
    DIRECTORY_TEST_CASE_STATUSES.map((status) => [status, given[status] ?? 0]),
  ) as Record<DirectoryTestCaseStatus, number>;
}

const STARTED = Date.UTC(2026, 10, 13, 14, 30);
const call = (
  callKey: string,
  tool: string,
  phase: "ambiguous" | "succeeded",
) => ({
  callKey,
  tool,
  phase,
  inputDigest: "sample-digest",
  ranBy: { kind: "direct-call" as const },
  endpoint: "https://mcp.example.com/mcp",
  planRevision: 3,
  startedAt: STARTED + 60_000,
});

export const DRAFTING: PlatformDirectoryTestArgumentDrafting = {
  status: "completed",
  drafts: [
    {
      caseId: "create_note#valid",
      arguments: { title: "Sample note" },
      rationale: "A short title, which the tool's schema requires.",
    },
    {
      caseId: "search_docs#missing-arguments",
      arguments: { query: 42 },
      expectedError: "invalid-arguments",
      rationale: "A number where the schema asks for text.",
    },
  ],
  undecided: [{ caseId: "delete_note#valid", reason: "needs_fixture" }],
  dropped: { schema: 1, credential: 0 },
  unsent: 2,
};

export const RESULTS: ToolTests = {
  run: {
    id: "run_2",
    status: "completed",
    createdAt: STARTED,
    updatedAt: STARTED + 300_000,
    testPlanRevision: 3,
  } as ToolTests["run"],
  testPlanRevision: 3,
  source: "report",
  sweep: { status: "completed" },
  tools: [
    {
      tool: "search_docs",
      status: "valid-input-succeeded",
      validInput: counts({ passed: 1 }),
      negative: counts({ passed: 1 }),
      cases: [
        { caseId: "search_docs#valid", kind: "valid", status: "passed" },
        {
          caseId: "search_docs#missing-arguments",
          kind: "negative",
          status: "passed",
        },
      ],
    },
    {
      tool: "create_note",
      status: "unexpected-failure",
      reason: "Valid input got a server error.",
      validInput: counts({ failed: 1 }),
      negative: counts({}),
      cases: [{ caseId: "create_note#valid", kind: "valid", status: "failed" }],
    },
    {
      tool: "delete_note",
      status: "ambiguous",
      reason:
        "The call started and did not finish, so it may have changed data. Check what it changed, then record what happened or rerun it.",
      validInput: counts({ ambiguous: 1 }),
      negative: counts({}),
      cases: [
        { caseId: "delete_note#valid", kind: "valid", status: "ambiguous" },
      ],
    },
    {
      tool: "list_projects",
      status: "excluded",
      validInput: counts({}),
      negative: counts({}),
      cases: [],
    },
  ],
  counts: {
    tools: {
      "valid-input-succeeded": 1,
      "expected-refusal": 0,
      "unexpected-failure": 1,
      ambiguous: 1,
      "setup-blocked": 0,
      excluded: 1,
      untested: 0,
      stale: 0,
    },
    validInput: counts({ passed: 1, failed: 1, ambiguous: 1 }),
    negative: counts({ passed: 1 }),
  },
  inDoubt: [call("delete_note#valid", "delete_note", "ambiguous")],
  cleanup: [call("cleanup:note", "delete_note", "succeeded")],
};
