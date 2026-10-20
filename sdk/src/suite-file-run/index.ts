/**
 * Local suite-file execution — the public facade.
 *
 * `runSuiteFile(sourceText, options)` validates, materializes and executes a
 * suite file against explicitly bound MCP servers, enforces its tool policy,
 * and decides it with the v2 verdict policy. It discovers no files, reads no
 * login store, prints nothing, writes no artifacts and never uploads.
 */

export { runSuiteFile, createSuiteFileRunner } from "./run-suite-file.js";
export type { SuiteFileRunnerRuntime } from "./run-suite-file.js";
export {
  SuiteFileRunError,
  SUITE_FILE_RUN_ERROR_CODES,
  isSuiteFileRunError,
} from "./errors.js";
export type {
  SuiteFileRunErrorCategory,
  SuiteFileRunErrorCode,
  SuiteFileRunErrorDetails,
  SuiteFileRunPhase,
  SuiteFileRunProblem,
} from "./errors.js";
export {
  DEFAULT_CONCURRENCY as SUITE_FILE_RUN_DEFAULT_CONCURRENCY,
  DEFAULT_ITERATION_TIMEOUT_MS as SUITE_FILE_RUN_DEFAULT_ITERATION_TIMEOUT_MS,
  DEFAULT_MAX_STEPS as SUITE_FILE_RUN_DEFAULT_MAX_STEPS,
  DEFAULT_SETUP_TIMEOUT_MS as SUITE_FILE_RUN_DEFAULT_SETUP_TIMEOUT_MS,
  suiteFileSourceHash,
} from "./preflight.js";
export { platformCaseFromSuiteFileCase } from "./platform-case.js";
export {
  LOCAL_EVAL_RUN_REPORT_KIND,
  LOCAL_VERDICT_AUTHORITY,
  formatLocalEvalRunSummary,
  isLocalEvalRunReport,
  localEvalRunMetadataSchema,
} from "./report.js";
export type { LocalEvalRunMetadata, LocalEvalRunReport } from "./report.js";
export type {
  McpjamInferenceConnection,
  RunSuiteFileOptions,
  SuiteFileAuthRequired,
  SuiteFileCaseRun,
  SuiteFileImportApproval,
  SuiteFileInferenceMode,
  SuiteFileInferenceOptions,
  SuiteFileInferenceRail,
  SuiteFileIterationEvidence,
  SuiteFileJudgeState,
  SuiteFileRefusalAttribution,
  SuiteFileRunIssue,
  SuiteFileRunProgressEvent,
  SuiteFileRunResult,
  SuiteFileRunTermination,
  SuiteFileRunVerdict,
  SuiteFileServerBinding,
  SuiteFileToolPolicyBlock,
} from "./types.js";
