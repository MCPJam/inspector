/**
 * Sample test plan data for the Readiness page's test plan section: a plan
 * with a read, a write that creates a fixture and a destructive call that
 * runs last, and its issues.
 */
import { vi } from "vitest";
import type {
  DirectoryTestPlan,
  DirectoryTestPlanIssue,
} from "@mcpjam/sdk/browser";
import type { DirectoryTestPlanSession } from "@/hooks/use-directory-test-plan";

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
