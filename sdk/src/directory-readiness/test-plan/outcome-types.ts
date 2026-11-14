/**
 * What a test plan's calls showed: the ledger's record of each call and who
 * made it, and the result of each case and each tool.
 *
 * Pure data. Safe from the browser entry.
 */

import type { DirectoryTestCase } from "./types.js";

/**
 * A call's place in the ledger. Each call is written `started` before it is
 * sent, so one a stopped worker left `started` is known to be unfinished.
 */
export const DIRECTORY_TEST_CALL_PHASES = [
  "planned",
  "started",
  "succeeded",
  "failed",
  "ambiguous",
] as const;
export type DirectoryTestCallPhase =
  (typeof DIRECTORY_TEST_CALL_PHASES)[number];

/**
 * How the server answered. `refused` (an HTTP refusal: sign-in, permission,
 * rate limit, session) and `unreachable` mean the tool itself never answered.
 */
export const DIRECTORY_TEST_CALL_OUTCOMES = [
  "result",
  "tool-error",
  "invalid-arguments",
  "rpc-error",
  "server-error",
  "refused",
  "unreachable",
] as const;
export type DirectoryTestCallOutcome =
  (typeof DIRECTORY_TEST_CALL_OUTCOMES)[number];

/**
 * Who made a call. A direct call is MCPJam's worker calling the server
 * itself, never a run inside Claude or ChatGPT; an eval run went through
 * MCPJam's eval host as the named client; a directory call was imported.
 */
export type DirectoryTestClient =
  | { kind: "direct-call" }
  | { kind: "eval-run"; client: string }
  | { kind: "directory"; directory: "claude" | "openai" };

/** One call as the ledger keeps it. */
export interface DirectoryTestCallRecord {
  /** The case id. */
  callKey: string;
  tool: string;
  phase: DirectoryTestCallPhase;
  /** `directoryTestCaseDigest` when the call was made. */
  inputDigest: string;
  ranBy: DirectoryTestClient;
  /** The reviewer account it ran as. */
  account?: string;
  /** The server URL it called. */
  endpoint?: string;
  catalogRevision?: number;
  /** The stored plan revision that holds the case's arguments. */
  planRevision?: number;
  startedAt?: number;
  finishedAt?: number;
  outcome?: DirectoryTestCallOutcome;
  /** Values read from a creating call's result, by fixture id. */
  captured?: Record<string, Record<string, string | number>>;
  /** What the server said, shortened. */
  detail?: string;
}

export const DIRECTORY_TEST_CASE_STATUSES = [
  "passed",
  "failed",
  "ambiguous",
  "blocked",
  "untested",
  "stale",
] as const;
export type DirectoryTestCaseStatus =
  (typeof DIRECTORY_TEST_CASE_STATUSES)[number];

export interface DirectoryTestCaseResult {
  caseId: string;
  kind: DirectoryTestCase["kind"];
  status: DirectoryTestCaseStatus;
  /** Why it is not passed, in words. */
  reason?: string;
  /** The call it was graded from: who ran it, as whom, where and when. */
  call?: DirectoryTestCallRecord;
}

export const DIRECTORY_TOOL_TEST_STATUSES = [
  "valid-input-succeeded",
  "expected-refusal",
  "unexpected-failure",
  "ambiguous",
  "setup-blocked",
  "excluded",
  "untested",
  "stale",
] as const;
export type DirectoryToolTestStatus =
  (typeof DIRECTORY_TOOL_TEST_STATUSES)[number];

export interface DirectoryToolTestResult {
  tool: string;
  status: DirectoryToolTestStatus;
  /** The case that decided a status other than success, and why. */
  reason?: string;
  /** Valid-input cases only: a passing negative case never counts here. */
  validInput: Record<DirectoryTestCaseStatus, number>;
  negative: Record<DirectoryTestCaseStatus, number>;
  cases: DirectoryTestCaseResult[];
}
