/**
 * A directory submission's test cases as an eval suite, as the API returns
 * them. Test cases need a conversation, so they run as evals: the submission
 * links to the suite that holds them and to the run that last ran them, and
 * MCPJam's eval runs and judges do the rest. Every result keeps the client
 * that ran it.
 */

export type PlatformDirectoryEvalCaseList = "positive" | "negative";

/** The run of the linked suite that last ran the submission's cases. */
export interface PlatformDirectorySubmissionEvalRun {
  id: string;
  runNumber: number;
  /** The eval run's status: `completed`, `failed`, `cancelled` and `timed_out` are final. */
  status: string;
  /** Its verdict, `pending` until the run ends. */
  result: string;
  createdAt: number;
  completedAt?: number;
}

/** What a submission links to. A suite or run deleted since reads as `null`. */
export interface PlatformDirectorySubmissionEvalLink {
  submissionId: string;
  /** The submission's revision. Send it back as `expectedRevision`. */
  revision: number;
  suite: { id: string; name: string } | null;
  run: PlatformDirectorySubmissionEvalRun | null;
  /** On a write: answered from an earlier write with the same idempotency key. */
  replayed?: true;
}

/** The plugin version, list and position a case was imported from. */
export interface PlatformDirectoryEvalCaseSource {
  pluginVersionId: string;
  list: PlatformDirectoryEvalCaseList;
  index: number;
}

/** One case's result in the linked run, as the run and its iterations recorded it. */
export interface PlatformDirectorySubmissionEvalResult {
  /** `null` when the run's iterations name no stored case. */
  testCaseId: string | null;
  title: string;
  prompt: string;
  expectation: string | null;
  /** A negative case passes when no tool is called. */
  negative: boolean;
  /** Where an imported case came from; `null` for any other case. */
  source: PlatformDirectoryEvalCaseSource | null;
  /** How its iterations were graded: assertions, a judge, both or neither. */
  assertions: "deterministic" | "judge" | "both" | "none";
  /** The judge that graded it, whether its verdict counts, and its passing score. */
  judge: { enforced: boolean; threshold: number } | null;
  /** The client the run ran as. A result is that client's, never the directory's own. */
  client: {
    name: string | null;
    hostStyle: string | null;
    /** `emulated`, or `harness:<id>` for a real agent runtime; `null` when not recorded. */
    engine: string | null;
    venue: string | null;
  };
  /** Its iterations, counted by result. */
  trials: { total: number; passed: number; failed: number; pending: number };
  iterations: Array<{
    iterationId: string;
    iterationNumber: number;
    status: string;
    result: string;
    model: string;
    /** The judge's score for this iteration, when it scored one. */
    judge: { score: number; passed: boolean } | null;
  }>;
}

export interface PlatformDirectorySubmissionEvals
  extends Omit<PlatformDirectorySubmissionEvalLink, "replayed"> {
  /** Empty until a run is linked. */
  results: PlatformDirectorySubmissionEvalResult[];
  /** The run has more iterations than one read returns; the eval run holds them all. */
  truncated: boolean;
}

export interface PlatformDirectorySubmissionEvalLinkBody {
  /** A stale revision conflicts only when the link changed since. */
  expectedRevision: number;
  /** A suite in the submission's project. `null` unlinks it and its run. */
  suiteId?: string | null;
  /** A run of the linked suite. `null` clears it. */
  runId?: string | null;
  idempotencyKey?: string;
}

/** The cases one import wrote into the linked suite, and the ones it could not. */
export interface PlatformDirectorySubmissionEvalImport {
  suiteId: string;
  pluginVersionId: string;
  /** Cases written now. An import of the same version again writes none. */
  created: number;
  /** Cases an earlier import of this version already wrote, left as they are. */
  existing: number;
  cases: Array<{
    list: PlatformDirectoryEvalCaseList;
    index: number;
    testCaseId: string;
    created: boolean;
  }>;
  skipped: Array<{
    list: PlatformDirectoryEvalCaseList;
    index: number;
    reason: "not_an_object" | "missing_prompt" | "missing_expectation" | "too_long" | "over_limit";
  }>;
}

/** One test case as ChatGPT's form takes it. */
export interface PlatformDirectoryPortalTestCase {
  prompt: string;
  expectation: string;
}

/**
 * The linked suite's cases in ChatGPT's shape, as a file: `content` is its
 * exact bytes, `{successful: [...], gracefulFailure: [...]}`.
 */
export interface PlatformDirectorySubmissionEvalExport {
  submissionId: string;
  directory: "openai";
  suite: { id: string; name: string };
  counts: { successful: number; gracefulFailure: number };
  /** How many of each the form takes for a first review. */
  required: { successful: number; gracefulFailure: number };
  /** Cases the form would refuse, so left out of the file. */
  omitted: Array<{
    testCaseId: string;
    title: string;
    negative: boolean;
    reason: "no_prompt" | "no_expectation";
  }>;
  filename: string;
  mediaType: "application/json";
  content: string;
}
