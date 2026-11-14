/**
 * Directory test plans: what a readiness run may call on a server, in what
 * order, what each call should do, and what it may change.
 *
 * A directory's reviewers run every tool, so a plan covers every tool unless
 * someone excludes it with a reason. A tool that may destroy data runs last
 * and only on fixtures: resources the plan names, found in the reviewer's
 * account or created by the plan and removed by its cleanup. Authorizing a
 * plan once is the consent for every call in it.
 *
 * Pure data. Safe from the browser entry.
 */

export const DIRECTORY_TEST_PLAN_SCHEMA_VERSION = 1 as const;

/** Bounds a stored plan stays within. The backend enforces the same numbers. */
export const DIRECTORY_TEST_PLAN_LIMITS = Object.freeze({
  maxTools: 500,
  maxCases: 1500,
  maxFixtures: 50,
  maxCleanupSteps: 50,
  maxIdLength: 200,
  /** Canonical JSON characters, so a plan fits one stored document. */
  maxPlanLength: 512 * 1024,
  maxCalls: 3000,
  maxConcurrency: 4,
  minCallTimeoutMs: 1000,
  maxCallTimeoutMs: 120_000,
});

/**
 * What a call may do, from the tool's annotations with MCP's defaults: only a
 * tool that says it is read-only reads, and a tool that writes is destructive
 * unless it says `destructiveHint: false`.
 */
export const DIRECTORY_TOOL_EFFECTS = ["read", "write", "destructive"] as const;
export type DirectoryToolEffect = (typeof DIRECTORY_TOOL_EFFECTS)[number];

/** `negative-only` runs only the cases that expect a refusal. */
export const DIRECTORY_TOOL_PLAN_ACTIONS = [
  "run",
  "negative-only",
  "excluded",
] as const;
export type DirectoryToolPlanAction =
  (typeof DIRECTORY_TOOL_PLAN_ACTIONS)[number];

export const DIRECTORY_TEST_EXCLUSION_REASONS = [
  "destructive",
  "costly",
  "external-effects",
  "needs-a-person",
  "other",
] as const;
export type DirectoryTestExclusionReason =
  (typeof DIRECTORY_TEST_EXCLUSION_REASONS)[number];

/** A tool as the server lists it. The dial's tool evidence fits as it is. */
export interface DirectoryTestPlanTool {
  name: string;
  annotations?: Record<string, unknown>;
  inputSchema?: unknown;
}

export interface DirectoryTestFixture {
  /** Arguments refer to it as `{ "$fixture": id, "value": name }`. */
  id: string;
  /** What it is, for the person authorizing the plan. */
  description: string;
  /**
   * `existing`: already in the reviewer's account. `created`: one case
   * creates it and a cleanup step removes it.
   */
  origin: "existing" | "created";
  /** An existing fixture's values, such as `{ id: "proj_1" }`. */
  values?: Record<string, string | number>;
  /** A created fixture's values: a dot path into the creating call's structured result for each. */
  capture?: Record<string, string>;
}

export interface DirectoryToolPlan {
  tool: string;
  /** More cautious than the annotations is allowed; less is refused. */
  effect: DirectoryToolEffect;
  /** It may reach past the server (send, post, pay), so no fixture holds it. */
  openWorld: boolean;
  action: DirectoryToolPlanAction;
  exclusion?: { reason: DirectoryTestExclusionReason; note?: string };
  /** Its permitted writes: the fixtures its calls may create or change. */
  writes: string[];
}

export interface DirectoryTestCase {
  /** Unique in the plan. The call ledger's key. */
  id: string;
  tool: string;
  /** A `negative` case expects a refusal and is never valid-input coverage. */
  kind: "valid" | "negative";
  /** Sent once fixture references are resolved. Absent until drafted. */
  arguments?: Record<string, unknown>;
  /** The refusal a negative case expects; `any` (the default) takes any error the tool or server returns. */
  expectedError?: "any" | "invalid-arguments" | "tool-error";
  /** What should happen, in words. Shown, never graded. */
  expectation?: string;
  creates?: string[];
}

export interface DirectoryTestCleanupStep {
  /** The created fixture this call removes. */
  fixture: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface DirectoryTestBudget {
  /** Calls one sweep may make. Cleanup always runs and is not counted. */
  maxCalls: number;
  concurrency: number;
  /** A read with no answer by then failed; a write is ambiguous. */
  callTimeoutMs: number;
}

export interface DirectoryTestPlan {
  schemaVersion: typeof DIRECTORY_TEST_PLAN_SCHEMA_VERSION;
  fixtures: DirectoryTestFixture[];
  /** Every tool the server lists, each with its action. */
  tools: DirectoryToolPlan[];
  /** In the order they run. */
  cases: DirectoryTestCase[];
  budget: DirectoryTestBudget;
  /** Runs after the sweep, an interrupted one too, for each created fixture. */
  cleanup: DirectoryTestCleanupStep[];
}

/** `limit` alone means the plan cannot be stored; any issue blocks authorizing it. */
export const DIRECTORY_TEST_PLAN_ISSUE_CODES = [
  "limit",
  "duplicate",
  "unknownTool",
  "missingTool",
  "lessCautious",
  "exclusion",
  "actionCases",
  "argumentsMissing",
  "unknownFixture",
  "writeScope",
  "fixtureCreation",
  "order",
  "cleanup",
] as const;
export type DirectoryTestPlanIssueCode =
  (typeof DIRECTORY_TEST_PLAN_ISSUE_CODES)[number];

export interface DirectoryTestPlanIssue {
  code: DirectoryTestPlanIssueCode;
  message: string;
  tool?: string;
  caseId?: string;
  fixture?: string;
}
