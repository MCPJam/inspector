/**
 * A directory submission's test plan and its tool tests as the API returns
 * them. The plan, its issues and the per-tool results are the SDK's own
 * types, so a plan the API serves and one drafted locally cannot disagree.
 */
import type {
  DirectoryTestCallRecord,
  DirectoryTestCaseStatus,
  DirectoryToolTestResult,
  DirectoryToolTestStatus,
} from "../directory-readiness/test-plan/outcome-types.js";
import type { SummarizeDirectoryToolTestsInput } from "../directory-readiness/test-plan/outcomes.js";
import type {
  DirectoryTestPlan,
  DirectoryTestPlanIssue,
} from "../directory-readiness/test-plan/types.js";
import type { PlatformReadinessRun } from "./types.js";

/** The server's stored tool list a plan was drafted from or checked against. */
export interface PlatformDirectoryTestPlanCatalog {
  /** The revision of the saved server's tool catalog. */
  revisionNumber: number;
  /** Epoch ms of the capture. */
  capturedAt: number;
}

/** A saved revision of a plan, without the plan. */
export interface PlatformDirectoryTestPlanRevision {
  submissionId: string;
  /** 1 for the first plan, one more on every save that changes it. Start a run with it. */
  revision: number;
  counts: { tools: number; cases: number; fixtures: number; cleanup: number };
  savedBy: string;
  savedAt: number;
}

/** Issues against the stored tool list. Any issue keeps a run from calling the plan's tools. */
interface Checked {
  issues: DirectoryTestPlanIssue[];
  catalog: PlatformDirectoryTestPlanCatalog;
}

export interface PlatformDirectoryTestPlanView extends PlatformDirectoryTestPlanRevision {
  plan: DirectoryTestPlan;
  /** `null`, with `catalog`, while MCPJam holds no tool list for the server. */
  issues: DirectoryTestPlanIssue[] | null;
  catalog: PlatformDirectoryTestPlanCatalog | null;
}

export interface PlatformDirectoryTestPlanSaved
  extends PlatformDirectoryTestPlanRevision, Checked {
  /** The plan was already the current one, so no revision was added. */
  replayed?: true;
}

/** A first plan for every tool the server lists. Not saved. */
export interface PlatformDirectoryTestPlanDraft extends Checked {
  plan: DirectoryTestPlan;
  /** The saved plan's revision, 0 when there is none: save the draft with it as `expectedRevision`. */
  currentRevision: number;
}

export interface PlatformDirectoryTestPlanSaveBody {
  /** The revision you read; 0 when the submission has no plan yet. */
  expectedRevision: number;
  plan: DirectoryTestPlan;
}

export type PlatformDirectoryTestCaseCounts = Record<
  DirectoryTestCaseStatus,
  number
>;

/** How a finished run's sweep of its plan ended, from its report. */
export interface PlatformDirectoryToolTestSweep {
  /** `not-run`: no tool was called; `stopped`: the sweep ended before every case. */
  status: "completed" | "stopped" | "not-run";
  /** Why no tool was called. */
  reason?: string;
  /** Why the sweep stopped early. */
  stopped?: SummarizeDirectoryToolTestsInput["stopped"];
  /** What kept the plan from running against the tools the server listed. */
  issues?: DirectoryTestPlanIssue[];
}

/** What one run's test plan calls showed. */
export interface PlatformDirectoryToolTests {
  /** `null` until a run of the submission names a test plan. */
  run: PlatformReadinessRun | null;
  /** The plan revision the run executed; `null` when it named none and called no tool. */
  testPlanRevision: number | null;
  /**
   * `report`: a finished run's own summary, judged against the tool list its
   * calls were made with. `ledger`: the calls recorded so far, graded as they
   * were made, while a run goes on or when it left no summary.
   */
  source: "report" | "ledger" | null;
  /** From the report only. */
  sweep?: PlatformDirectoryToolTestSweep;
  /** One result per tool in the plan; each case keeps the call that decided it and who made it. */
  tools: DirectoryToolTestResult[];
  counts: {
    tools: Record<DirectoryToolTestStatus, number>;
    /** Valid-input cases: what the calls showed works. */
    validInput: PlatformDirectoryTestCaseCounts;
    /** Negative cases, counted apart: a refusal never shows that a tool works. */
    negative: PlatformDirectoryTestCaseCounts;
  };
  /** Calls that may have changed data and never finished. None is sent again; check what each one changed. */
  inDoubt: DirectoryTestCallRecord[];
  /** The calls that removed the fixtures the plan created. */
  cleanup: DirectoryTestCallRecord[];
}
