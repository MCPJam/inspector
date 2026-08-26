import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Command } from "commander";
import {
  createEvalCaseOperation,
  createEvalSuiteOperation,
  deleteEvalCaseOperation,
  deleteEvalSuiteOperation,
  generateEvalCasesOperation,
  getEvalCaseOperation,
  cancelEvalRunOperation,
  getEvalIterationTraceOperation,
  getEvalRunOperation,
  requestEvalRunJudgeOperation,
  listEvalCheckReposOperation,
  connectEvalCheckRepoOperation,
  getEvalRunStepsOperation,
  getEvalSuiteOperation,
  listEvalCasesOperation,
  listEvalRunIterationsOperation,
  listEvalSuiteRunsOperation,
  listEvalSuitesOperation,
  projectResolutionError,
  resolveEnvironmentOperation,
  resolveProject,
  runEvalCaseOperation,
  runEvalSuiteOperation,
  setEvalSuiteEnvironmentsOperation,
  setEvalSuiteScheduleOperation,
  updateEvalCaseOperation,
  updateEvalSuiteOperation,
  buildAppPermalink,
  type CreateEvalSuiteInput,
  type PlatformEvalRunDisclosure,
  type PlatformOperation,
  type PlatformPermalink,
} from "@mcpjam/sdk/platform";
import {
  validateImportToolReferences,
  type ImportToolFinding,
} from "../lib/eval-import-live-validation.js";
import { JsonInputContext } from "../lib/json-input.js";
import {
  type RenderedScreenshot,
  extractRenderedScreenshots,
  extractIterationVideoUrl,
  screenshotFilename,
} from "../lib/eval-screenshots.js";
import {
  CliError,
  cliError,
  operationalError,
  setProcessExitCode,
  usageError,
  writeResult,
} from "../lib/output.js";
import {
  applyGateWaiver,
  buildCorpus,
  buildEvalRunReport,
  buildRunCompareReport,
  detectFlakyCases,
  evaluateCompareGates,
  formatGateReport,
  formatGateWaiverLine,
  formatSuiteFileFindings,
  GATE_WAIVER_MAX_REASON_LENGTH,
  GATE_WAIVER_REASON_NOTICE,
  gateOutcomeVerdict,
  HostedOnlyCaseError,
  loadEvalSuiteFile,
  MAX_SUITE_FILE_BYTES,
  serializeEvalSuiteFile,
  verifyCorpusLock,
  type FlakyCase,
  type GateReport,
  type LoadedCorpus,
  type PublicMatchOptions,
  type ResolvedEvalSuiteFile,
  type StructuredCaseResult,
  type StructuredEvalRunInput,
  type StructuredRunReport,
  type SuiteFileFailureStage,
} from "@mcpjam/sdk";
import { isPlatformApiError } from "@mcpjam/sdk/platform";
import type {
  PlatformApiClient,
  PlatformEnvironmentResolved,
  PlatformEvalCase,
  PlatformEvalIteration,
  PlatformEvalRun,
  PlatformRunCompare,
  RunEvalSuiteResult,
} from "@mcpjam/sdk/platform";
import { writeFileAtomic } from "../lib/atomic-write.js";
import {
  buildSuiteFileFromPlatform,
  defaultSuiteFilePath,
  suiteFileTooLarge,
  type SuiteExportFinding,
} from "../lib/eval-suite-export.js";
import {
  executeEvalRunFromFile,
  looksLikeVersionedSuiteFile,
} from "../lib/eval-run-file.js";
import {
  CORPUS_DRIFT_EXIT_CODE,
  CORPUS_INCOMPLETE_EXIT_CODE,
  CORPUS_USAGE_EXIT_CODE,
  corpusFetchFailure,
  DEFAULT_CORPUS_LOCK_PATH,
  readCorpusLock,
  renderCorpusDrift,
  resolveCorpusLockPath,
  writeCorpusLockAtomic,
} from "../lib/corpus-lock.js";
import {
  EVAL_GATE_INCOMPLETE_EXIT_CODE,
  EVAL_GATE_USAGE_EXIT_CODE,
  TERMINAL_RUN_STATUSES,
  evalGateExitCode,
  isNonVerdictRunResult,
  isNonVerdictRunStatus,
} from "../lib/eval-gate-exit-code.js";
import {
  activeWaiverForRun,
  resolveBaselineSelector,
  compareBaseSelector,
  baselineNotFoundReason,
  comparePolicyFromGateOptions,
  evaluateBaselineComparison,
  mergeGateReports,
  policyFromOptions,
  parseWaiverExpiry,
  policyNeedsIterations,
  reportForRun,
  type EvalGateOptions,
} from "../lib/eval-gate.js";
import {
  classifyLaunchErrorExitCode,
  evalRunWaitExitCode,
  worstOf,
  type EvalRunWaitRunOutcome,
} from "../lib/eval-run-exit-code.js";
import { fetchAllIterations, p95Of } from "../lib/eval-iterations.js";
import {
  decisionSummaryFromIterations,
  readEvalRunDecisionSummary,
} from "../lib/eval-decision-summary.js";
import type { EvalRunDecisionSummary } from "@mcpjam/sdk";
import {
  comparePolicyFromOptions,
  compareGateInputFrom,
  flakyInputFrom,
  type EvalCompareOptions,
} from "../lib/eval-compare.js";
import {
  parseReporterFormat,
  writeEvalDecisionSummary,
  writeReporterArtifact,
  writeReporterResult,
} from "../lib/reporting.js";
import { DEFAULT_PLATFORM_ORIGIN } from "../lib/platform-auth.js";
import { preflightCloudCredentials } from "../lib/cloud-context.js";
import {
  addProjectOption,
  platformOptionsOf,
  runPlatformOperation as runPlatformCommand,
  runCloudOp,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { resolveCloudProjectArgs, appendProjectLinkHint } from "../lib/cloud-scope.js";
import {
  getGlobalOptions,
  parsePositiveInteger,
} from "../lib/server-config.js";
import {
  detectInlineImageProtocol,
  encodeInlineImage,
} from "../lib/terminal-image.js";

type CreateOptions = PlatformOptions & {
  project?: string;
  file?: string;
  json?: string;
  name?: string;
  model?: string;
  provider?: string;
  server?: string[];
};

/**
 * A variadic selector maps to the SINGULAR op field for one value and the
 * PLURAL for several. The op rejects both together, and the singular field
 * carries the semantics (and description) callers already rely on.
 */
function selectorField(
  singular: string,
  plural: string,
  values: string[] | undefined
): Record<string, string | string[]> {
  if (!values?.length) return {};
  return values.length === 1
    ? { [singular]: values[0]! }
    : { [plural]: values };
}

/**
 * The `--compose-*` flags as the op's `compose` object, or nothing at all.
 *
 * `--compose-host` is what MAKES it a composed run — the other axes only
 * refine a stack that already has a host — so a `--compose-computer` with no
 * host is a usage error rather than a silently ignored flag. Combining any of
 * them with `--environment`/`--host`/`--all-targets` is rejected by the op,
 * which owns that rule for every surface.
 */
function composeField(options: {
  composeHost?: string;
  composeComputer?: string;
  composeModel?: string | string[];
  composeServerGroup?: string;
  composeSkill?: string[];
  withClientDefault?: boolean;
  saveTargets?: boolean;
}): {
  compose?: {
    host: string;
    serverGroup?: string;
    models?: string[];
    includeClientDefault?: boolean;
    saveTargets?: boolean;
    computer?: string;
    skills?: { mode: "explicit"; skillIds: string[] };
  };
} {
  const models = Array.isArray(options.composeModel)
    ? options.composeModel
    : options.composeModel
      ? [options.composeModel]
      : undefined;
  const refinements =
    options.composeComputer !== undefined ||
    models !== undefined ||
    options.composeServerGroup !== undefined ||
    (options.composeSkill?.length ?? 0) > 0 ||
    options.withClientDefault === true ||
    options.saveTargets === true;
  if (!options.composeHost) {
    if (refinements) {
      throw usageError(
        "--compose-* flags need --compose-host: the host is what the composed stack runs as, and the others only refine it."
      );
    }
    return {};
  }
  return {
    compose: {
      host: options.composeHost,
      ...(options.composeServerGroup !== undefined
        ? { serverGroup: options.composeServerGroup }
        : {}),
      ...(models !== undefined ? { models } : {}),
      ...(options.withClientDefault === true
        ? { includeClientDefault: true }
        : {}),
      ...(options.saveTargets === true ? { saveTargets: true } : {}),
      ...(options.composeComputer !== undefined
        ? { computer: options.composeComputer }
        : {}),
      ...(options.composeSkill?.length
        ? {
            skills: {
              mode: "explicit" as const,
              skillIds: options.composeSkill,
            },
          }
        : {}),
    },
  };
}

function composeModelTail(modelId: string | undefined): string {
  if (!modelId) return "default";
  const slash = modelId.lastIndexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

/**
 * `--iterations 3` → 3, and anything else → a usage error rather than NaN.
 *
 * The emptiness guard is not decoration: `Number("")` and `Number(" ")` are
 * both `0`, and `0` passes `isInteger` and `isFinite` alike. Without it
 * `--min-pass-rate ""` would become a threshold of 0 — inside the documented
 * range, so nothing downstream objects, and every run passes.
 */
function parseIntOption(raw: string, flag: string): number {
  if (raw.trim() === "") {
    throw usageError(`${flag} requires a value.`);
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw usageError(`${flag} must be a whole number (got "${raw}").`);
  }
  return parsed;
}

function parseNumberOption(raw: string, flag: string): number {
  if (raw.trim() === "") {
    throw usageError(`${flag} requires a value.`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw usageError(`${flag} must be a number (got "${raw}").`);
  }
  return parsed;
}

/**
 * `--match-options '{"toolCallOrder":"exact"}'`. Malformed JSON is a usage
 * error naming the flag: the op's own schema would reject the parsed value
 * with a field-level message, which is unhelpful when the real problem is a
 * missing quote in the shell.
 */
function parseMatchOptionsOption(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw usageError(
      `--match-options must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError("--match-options must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Human-format summary of a launch: one `View:` link per started run, a group
 * line when several were launched, and a named line per failure.
 *
 * Silent on `--format json`, where the receipt IS the output — see the
 * one-document rule at the call site.
 */
function writeRunGroupSummary(
  format: string,
  webOrigin: string,
  result: {
    project: { id: string };
    suite: { id: string };
    outcome: string;
    startedCount: number;
    failedCount: number;
    runGroupId?: string;
    composed?: {
      environments?: Array<{ id: string; modelId?: string }>;
      environment?: { id: string; modelId?: string };
    };
    targets: Array<
      | {
          status: "started";
          runId: string;
          host?: { id: string; name: string };
          environment?: { id: string; name?: string | null } | null;
        }
      | {
          status: "failed";
          host?: { id: string; name: string };
          environment?: { id: string; name?: string | null } | null;
          error: { code: string; message: string };
        }
    >;
  }
): void {
  if (format !== "human") return;
  for (const target of result.targets) {
    if (target.status !== "started") continue;
    writeRunLink(format, webOrigin, {
      projectId: result.project.id,
      suiteId: result.suite.id,
      runId: target.runId,
    });
  }
  const total = result.startedCount + result.failedCount;
  if (total > 1) {
    process.stdout.write(
      `Started ${result.startedCount}/${total} runs` +
        (result.runGroupId ? ` (group ${result.runGroupId})` : "") +
        "\n"
    );
  }
  for (const target of result.targets) {
    if (target.status !== "failed") continue;
    const cell = (
      result.composed?.environments ??
      (result.composed?.environment ? [result.composed.environment] : [])
    ).find((entry) => entry.id === target.environment?.id);
    const base =
      target.host?.name ??
      target.host?.id ??
      target.environment?.name ??
      target.environment?.id ??
      "target";
    const label =
      cell || result.composed
        ? `${base} · ${composeModelTail(cell?.modelId)}`
        : base;
    process.stderr.write(
      `Failed: ${label} — ${target.error.code}: ${target.error.message}\n`
    );
  }
}

/**
 * Human-format block for the pre-run disclosure `run_eval_suite` fetched for
 * this launch — the twin of `writeRunGroupSummary`, and printed BEFORE it: a
 * `--format json` document already carries `disclosure` inside the single
 * receipt, so appending prose to it would break the one-document rule the
 * same way a second summary line would. This is the human-only rendering of
 * exactly that field.
 *
 * `execution` vs `executionAbsence` render DIFFERENT copy on purpose — never
 * collapse them. `'ingested-run'` means MCPJam did not execute this;
 * `'plan-unresolved'` means a run that WILL execute and WILL call models this
 * CLI simply cannot name yet. Printing the ingest wording for the second
 * would tell someone about to launch that nothing leaves, which is the exact
 * bug g4a fixed on the backend — reintroducing it here at the presentation
 * layer would be the same bug in a different process.
 */
function writeRunDisclosure(
  format: string,
  disclosure: PlatformEvalRunDisclosure | undefined,
  stream: NodeJS.WritableStream = process.stdout
): void {
  if (format !== "human" || !disclosure) return;
  const lines: string[] = ["Pre-run disclosure:"];
  if (disclosure.execution) {
    const execution = disclosure.execution;
    const locus =
      execution.locus.known === true
        ? execution.locus.hosted
          ? "MCPJam-hosted"
          : "your own machine"
        : "unknown";
    lines.push(`  Execution: ${execution.engine} · ${locus}`);
    if (execution.models.length > 0) {
      for (const model of execution.models) {
        const destination = model.byok?.baseUrlHost
          ? model.byok.baseUrlHost
          : model.rail.managed
            ? `${model.rail.possibleDestinations.join(" or ")} (currently: ${model.rail.outcomeIfRunNow.destination})`
            : model.tenantEgress;
        lines.push(`  Model: ${model.modelId} — ${destination}`);
      }
    } else if (execution.modelsUnresolved) {
      lines.push(`  Models: not derivable — ${execution.modelsUnresolved.reason}`);
    }
    if (execution.sandbox.engaged) {
      lines.push(`  Sandbox: engaged (${execution.sandbox.vendor ?? "?"})`);
    }
  } else if (disclosure.executionAbsence) {
    const { kind, reason } = disclosure.executionAbsence;
    lines.push(
      kind === "ingested-run"
        ? `  Execution: none — this run was ingested, MCPJam did not execute it (${reason})`
        : `  Execution: not yet resolved — this run WILL execute and WILL call models, they are just not derivable yet (${reason})`
    );
  }
  // `capture` is ALWAYS present, regardless of `execution`/`executionAbsence`
  // — it is what happens to content once it exists, not a fact about whether
  // this run executed. This is the human's only pre-launch view (the
  // standalone disclosure command is deliberately excluded), so a
  // consequential setting like a non-DLP redaction module or a captureLevel
  // of "full" must not be silently absent from the printed block.
  lines.push(
    `  Capture: ${disclosure.capture.captureLevel} · reporting ${disclosure.capture.reportingMode}`
  );
  lines.push(
    `  Redaction: ${disclosure.capture.redaction.kind}` +
      (disclosure.capture.redaction.isDlp
        ? ""
        : ` — NOT a DLP system (${disclosure.capture.redaction.limitation})`)
  );
  lines.push(
    `  Export defaults: ${
      disclosure.capture.exportDefaults.includeContent
        ? "includes content"
        : "excludes content"
    } (${disclosure.capture.exportDefaults.note})`
  );
  const firingAnalysis = disclosure.analysis.filter(
    (touchpoint) => typeof touchpoint.fires === "string"
  );
  if (firingAnalysis.length > 0) {
    // One line PER touchpoint — different touchpoints can have different
    // destinations, and pooling them under the first one's would misattribute
    // where the others' evidence actually goes.
    for (const touchpoint of firingAnalysis) {
      // "fires automatically" vs "fires only if asked" are different consent
      // stories — one sends evidence the moment the run completes, with no
      // further action from anyone; the other only on request. A surface
      // whose whole job is telling people what happens before they agree to
      // it must not flatten that distinction just because both cases "fire".
      const firesLabel =
        touchpoint.fires === "auto-on-completion"
          ? "fires automatically on completion"
          : "fires only if explicitly requested";
      lines.push(
        `  Analysis: ${touchpoint.label} ${firesLabel}, may send evidence to ${touchpoint.destinations.join(", ")}`
      );
    }
  } else {
    lines.push("  Analysis: no analyzer/judge touchpoint can fire for this run");
  }
  lines.push(
    disclosure.retention.effectiveToday === "kept-indefinitely"
      ? "  Retention: kept indefinitely"
      : `  Retention: swept after ${disclosure.retention.policyDays ?? "?"} day(s)`
  );
  lines.push(
    disclosure.region.stated
      ? `  Region: ${disclosure.region.value}`
      : "  Region: not stated"
  );
  const engaged = disclosure.subprocessors.filter((entry) => entry.engaged);
  if (engaged.length > 0) {
    lines.push(
      `  Subprocessors: ${engaged.map((entry) => entry.vendor).join(", ")}`
    );
  }
  stream.write(`${lines.join("\n")}\n`);
}

/**
 * Print a deep link to a run, after the command's own machine-readable
 * output.
 *
 * HUMAN FORMAT ONLY, and written separately rather than folded into
 * `writeResult`: that helper is format-generic and its `--format json` bytes
 * are a contract scripts parse. A trailing prose line would break every one
 * of them, so the gate lives here at the call site.
 *
 * The route is the unflagged `/evals/suite/:suiteId/runs/:runId` — the
 * `/ci-evals` twin is behind the `evaluate-ci` flag and its redirect drops
 * the run path.
 */
function writeRunLink(
  format: string,
  webOrigin: string,
  run: { projectId?: string; suiteId?: string; runId?: string }
): void {
  if (format !== "human") return;
  const suiteId = run.suiteId?.trim();
  const runId = run.runId?.trim();
  const projectId = run.projectId?.trim();
  if (!suiteId || !runId || !projectId) return;
  let permalink: PlatformPermalink;
  try {
    permalink = buildAppPermalink(
      {
        type: "eval_run",
        id: runId,
        parent: { type: "eval_suite", id: suiteId },
        projectId,
      },
      { appOrigin: webOrigin }
    );
  } catch {
    // A convenience line may never fail a command that already succeeded.
    return;
  }
  process.stdout.write(`View: ${permalink.url}\n`);
}

/** Judge keys the CLI knows how to label, in the order it prints them. */
const JUDGE_LABELS: ReadonlyArray<[string, string]> = [
  ["goalCompletion", "goal completion"],
  ["groundedness", "groundedness"],
];

/**
 * One line per judge that has actually been asked to grade this run.
 *
 * Human format only — `--format json` output stays byte-identical, and the
 * full `judges` envelope is in the JSON either way. A judge nobody requested
 * prints NOTHING rather than a "not requested" line each: the absence is the
 * answer, and enumerating every judge the platform could run would turn a
 * status read into a catalog.
 */
function writeJudgeSummary(format: string, judges: unknown): void {
  if (format !== "human" || !judges || typeof judges !== "object") return;
  for (const [key, label] of JUDGE_LABELS) {
    const judge = (judges as Record<string, any>)[key];
    const status = judge?.status;
    // null/absent = never requested.
    if (!status) continue;
    if (status !== "completed") {
      const code =
        typeof judge.errorCode === "string" ? ` (${judge.errorCode})` : "";
      process.stdout.write(`Judge ${label}: ${status}${code}\n`);
      continue;
    }
    const cases: any[] = Array.isArray(judge.cases) ? judge.cases : [];
    if (cases.length === 0) {
      // A completed judge with no cases graded nothing — its summary says why,
      // and "0/0 passed" would bury that behind a number.
      const why =
        typeof judge.summary === "string" ? judge.summary : "nothing graded";
      process.stdout.write(`Judge ${label}: ${why}\n`);
      continue;
    }
    const passed = cases.filter((c) => c?.passed === true).length;
    const at =
      typeof judge.threshold === "number"
        ? ` at threshold ${judge.threshold}`
        : "";
    const model =
      typeof judge.modelUsed === "string" ? ` — ${judge.modelUsed}` : "";
    process.stdout.write(
      `Judge ${label}: ${passed}/${cases.length} passed${at}${model}\n`
    );
  }
}

/**
 * Read a suite definition file by literal path (or `-` for stdin). Unlike the
 * `@file` convention in json-input.ts, `--file` points at a real path — the
 * common affordance for a JSON document on disk.
 */
function readFileOrStdin(value: string, label: string): string {
  try {
    return value === "-"
      ? readFileSync(0, "utf8")
      : readFileSync(value, "utf8");
  } catch (error) {
    throw usageError(`Failed to read ${label} "${value}".`, {
      source: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Build the create_eval_suite input from a JSON suite definition (via --file
 * or --json) plus scalar flag overrides, then validate it against the
 * operation's own schema so errors surface as usage errors before any network
 * call.
 */
function loadSuiteDefinition(options: CreateOptions): CreateEvalSuiteInput {
  if (options.file !== undefined && options.json !== undefined) {
    throw usageError("Provide either --file or --json, not both.");
  }

  let base: unknown = {};
  if (options.file !== undefined) {
    const text = readFileOrStdin(options.file, "--file");
    if (text.trim() === "") {
      throw usageError("--file input is empty.");
    }
    if (looksLikeVersionedSuiteFile(text)) {
      throw usageError(
        "That looks like a versioned suite file. Use `eval run --file` to upload and run it."
      );
    }
    try {
      base = JSON.parse(text);
    } catch (error) {
      throw usageError("--file must contain valid JSON.", {
        source: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (options.json !== undefined) {
    base = new JsonInputContext().parseJsonInputRecord(options.json, "--json");
  }

  if (base === undefined || base === null) {
    base = {};
  }
  if (typeof base !== "object" || Array.isArray(base)) {
    throw usageError("Suite definition must be a JSON object.");
  }
  if ("schemaVersion" in (base as Record<string, unknown>)) {
    throw usageError(
      "That looks like a versioned suite file. Use `eval run --file` to upload and run it."
    );
  }

  const merged = {
    ...(base as Record<string, unknown>),
    ...(options.project !== undefined ? { project: options.project } : {}),
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.server !== undefined ? { servers: options.server } : {}),
  };

  const parsed = createEvalSuiteOperation.inputSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw usageError(`Invalid suite definition: ${detail}`);
  }
  return parsed.data;
}

/** Read a partial JSON body object from --file / --json (or {} when absent). */
function loadBodyObject(options: {
  file?: string;
  json?: string;
}): Record<string, unknown> {
  if (options.file !== undefined && options.json !== undefined) {
    throw usageError("Provide either --file or --json, not both.");
  }
  let base: unknown = {};
  if (options.file !== undefined) {
    const text = readFileOrStdin(options.file, "--file");
    if (text.trim() === "") throw usageError("--file input is empty.");
    try {
      base = JSON.parse(text);
    } catch (error) {
      throw usageError("--file must contain valid JSON.", {
        source: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (options.json !== undefined) {
    base = new JsonInputContext().parseJsonInputRecord(options.json, "--json");
  }
  if (base === undefined || base === null) base = {};
  if (typeof base !== "object" || Array.isArray(base)) {
    throw usageError("Body must be a JSON object.");
  }
  return base as Record<string, unknown>;
}

/**
 * Operation schemas still require `project`. Cloud CLI fills that later
 * from `--project` / env / link / automatic, so callers that validate
 * before `executeOp` must drop the requirement.
 */
function schemaWithOptionalProject<TInput>(
  schema: PlatformOperation<TInput, unknown>["inputSchema"]
): PlatformOperation<TInput, unknown>["inputSchema"] {
  const objectSchema = schema as {
    shape?: Record<string, unknown>;
    partial?: (
      mask: { project: true }
    ) => PlatformOperation<TInput, unknown>["inputSchema"];
  };
  if (
    objectSchema.shape !== undefined &&
    "project" in objectSchema.shape &&
    typeof objectSchema.partial === "function"
  ) {
    return objectSchema.partial({ project: true });
  }
  return schema;
}

/** Validate a merged input object against an operation's schema (usage error on failure). */
function validateOpInput<TInput>(
  op: PlatformOperation<TInput, unknown>,
  raw: unknown,
  extras: { projectOptional?: boolean } = {}
): TInput {
  const schema = extras.projectOptional
    ? schemaWithOptionalProject(op.inputSchema)
    : op.inputSchema;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw usageError(`Invalid input: ${detail}`);
  }
  return parsed.data as TInput;
}

/** Run an operation with a pre-validated input and print the result. */
async function executeOp<TInput, TOutput>(
  op: PlatformOperation<TInput, TOutput>,
  input: TInput,
  options: PlatformOptions & { project?: string },
  command: Command
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const inputProject =
    options.project === undefined &&
    typeof (input as { project?: unknown }).project === "string"
      ? (input as { project: string }).project
      : undefined;
  const resolved = resolveCloudProjectArgs(options, { inputProject });
  const filled = { ...(input as TInput & { project?: string }) };
  delete filled.project;
  if (resolved.project !== undefined) {
    filled.project = resolved.project;
  }
  const result = await runPlatformCommand(
    platformOptionsOf(command),
    globalOptions.timeout,
    ({ client, signal }) =>
      op.execute(filled as TInput, { client, signal }),
    {
      projectScope: resolved.projectScope,
      quiet: globalOptions.quiet,
    }
  );
  writeResult(result, globalOptions.format);
}

/** Merge `eval update` flags onto an optional --file/--json suite-update body. */
function buildSuiteUpdateInput(
  options: Record<string, any>
): Record<string, unknown> {
  const input: Record<string, any> = { ...loadBodyObject(options) };
  input.suite = options.suite;
  if (options.project !== undefined) input.project = options.project;
  if (options.name !== undefined) input.name = options.name;
  if (options.description !== undefined)
    input.description = options.description;
  if (options.server !== undefined)
    input.environment = {
      ...(input.environment ?? {}),
      servers: options.server,
    };
  if (options.computerImage !== undefined) {
    input.environment = {
      ...(input.environment ?? {}),
      // NULL, not undefined — `off` has to reach the wire as an explicit
      // clear, and omitting the servers alongside it preserves them.
      computerEnvironment:
        options.computerImage === "off" ? null : options.computerImage,
    };
  }
  if (options.host !== undefined)
    input.hosts = options.host.map((host: string) => ({ host }));

  const exec = { ...(input.executionConfig ?? {}) };
  if (options.model !== undefined) exec.model = options.model;
  if (options.systemPrompt !== undefined)
    exec.systemPrompt = options.systemPrompt;
  if (options.temperature !== undefined)
    exec.temperature = Number(options.temperature);
  if (Object.keys(exec).length > 0) input.executionConfig = exec;

  const settings = { ...(input.settings ?? {}) };
  if (options.minAccuracy !== undefined)
    settings.minimumAccuracy = Number(options.minAccuracy);
  if (options.minIterations !== undefined) {
    if (options.minIterations === "off") {
      // NULL, not undefined. `undefined` is "leave this alone" all the way
      // down the stack, so writing it here would make `--min-iterations off`
      // a no-op that reports success.
      settings.minimumIterations = null;
    } else {
      const iterations = Number(options.minIterations);
      if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10) {
        throw usageError(
          '--min-iterations must be a whole number from 1 to 10, or "off".'
        );
      }
      settings.minimumIterations = iterations;
    }
  }
  const mo = { ...(settings.matchOptions ?? {}) };
  if (options.toolCallOrder !== undefined)
    mo.toolCallOrder = options.toolCallOrder;
  if (options.arguments !== undefined) mo.arguments = options.arguments;
  if (options.extraToolCalls !== undefined)
    mo.extraToolCalls =
      options.extraToolCalls === "unlimited"
        ? "unlimited"
        : Number(options.extraToolCalls);
  if (Object.keys(mo).length > 0) settings.matchOptions = mo;
  const judge = { ...(settings.judge ?? {}) };
  if (options.judge !== undefined) {
    if (options.judge !== "on" && options.judge !== "off") {
      throw usageError('--judge must be "on" or "off".');
    }
    // ONE switch, matching the app's LLM-as-Judge toggle, which binds to
    // `enabled && autoRun`. Writing `enabled` alone changes nothing a user
    // can observe: it already defaults on, and the grader gates on `autoRun`.
    // "Turn the judge on" means "grade my runs", so both flip together.
    judge.enabled = options.judge === "on";
    judge.autoRun = options.judge === "on";
  }
  if (options.judgeModel !== undefined) judge.model = options.judgeModel;
  if (options.judgeThreshold !== undefined) {
    judge.threshold = parseJudgeThreshold(options.judgeThreshold);
  }
  if (Object.keys(judge).length > 0) settings.judge = judge;
  if (Object.keys(settings).length > 0) input.settings = settings;

  return input;
}

/**
 * `--judge-threshold`, coerced and bounded. Shared by `eval update` and
 * `eval judge`: two copies of a range check are two places to update when the
 * range moves, and the second copy is the one that gets forgotten.
 */
function parseJudgeThreshold(raw: string): number {
  // Reject blank BEFORE coercing: `Number("")` and `Number("   ")` are both
  // `0`, which is a perfectly valid threshold — so an empty flag would sail
  // through the range check below and silently set "every case passes"
  // (`passed = score >= 0`). A refusal is the only honest answer to a flag
  // whose value the caller never supplied.
  const normalized = raw.trim();
  const threshold = normalized === "" ? Number.NaN : Number(normalized);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw usageError("--judge-threshold must be a number between 0 and 1.");
  }
  return threshold;
}

/**
 * Hyphens on the flag, underscores on the wire: the flag reads like every other
 * CLI value, and the API keeps the platform's own spelling. Both spellings are
 * accepted so a caller echoing back an API value is not punished for it.
 */
const OUTAGE_POLICY_BY_FLAG = new Map([
  ["fail-open", "fail_open"],
  ["fail-closed", "fail_closed"],
  ["fail_open", "fail_open"],
  ["fail_closed", "fail_closed"],
]);

/** Merge a --file/--json case body with the selectors (+ optional --title). */
function buildCaseInput(
  options: Record<string, any>,
  opts: { requireCase: boolean }
): Record<string, unknown> {
  const input: Record<string, any> = { ...loadBodyObject(options) };
  if (options.project !== undefined) input.project = options.project;
  input.suite = options.suite;
  if (opts.requireCase) input.case = options.case;
  if (options.title !== undefined) input.title = options.title;
  return input;
}

/** A screenshot entry as emitted in JSON output (and after an optional save). */
type ScreenshotItem = RenderedScreenshot & { savedTo?: string };

/**
 * Fetch raw artifact bytes (screenshot PNG or replay `.webm`) for a resolved
 * URL, bounded by the request timeout. `kind` only shapes the error wording.
 */
async function fetchArtifactBytes(
  url: string,
  timeoutMs: number,
  kind = "screenshot"
): Promise<Uint8Array> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), timeoutMs);
  handle.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw operationalError(
        `Failed to download ${kind} (HTTP ${response.status}).`,
        { url }
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw operationalError(
        `Timed out downloading ${kind} after ${timeoutMs}ms.`,
        { url }
      );
    }
    throw error;
  } finally {
    clearTimeout(handle);
  }
}

/** Fetch raw image bytes for a screenshot URL, bounded by the request timeout. */
function fetchScreenshotBytes(
  url: string,
  timeoutMs: number
): Promise<Uint8Array> {
  return fetchArtifactBytes(url, timeoutMs, "screenshot");
}

/**
 * Resolve where a screenshot should be written for `--out`. A path that is (or
 * looks like) a directory gets a generated per-render filename; otherwise the
 * literal path is used — but only when saving a single image, so multiple
 * renders never overwrite one file.
 */
function resolveScreenshotPath(
  out: string,
  shot: RenderedScreenshot,
  index: number,
  total: number
): string {
  const looksLikeDir =
    out.endsWith("/") || (existsSync(out) && statSync(out).isDirectory());
  if (looksLikeDir) {
    return join(out, screenshotFilename(shot, index));
  }
  if (total > 1) {
    throw usageError(
      "--out must be a directory when the iteration rendered multiple screenshots."
    );
  }
  return out;
}

/** Commander collector for a repeatable `--flag value` option. */
function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const DEFAULT_RUN_WAIT_TIMEOUT_MS = 600_000;
const RUN_POLL_INTERVAL_MS = 3000;

async function waitForEvalRun(
  client: Pick<PlatformApiClient, "getEvalRun">,
  signal: AbortSignal,
  projectId: string,
  runId: string,
  deadline: number
) {
  let run = await client.getEvalRun({ projectId, runId }, { signal });
  while (!TERMINAL_RUN_STATUSES.has(run.status)) {
    if (Date.now() >= deadline) {
      throw operationalError(
        `Eval run "${runId}" is still ${run.status} after waiting for completion.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, RUN_POLL_INTERVAL_MS));
    run = await client.getEvalRun({ projectId, runId }, { signal });
  }
  return run;
}

function launchFailureCases(
  result: RunEvalSuiteResult
): StructuredCaseResult[] {
  return result.targets.flatMap((target, index) => {
    if (target.status !== "failed") return [];
    const targetName =
      target.environment?.name ?? target.host?.name ?? `target ${index + 1}`;
    return [
      {
        id: `launch:${index + 1}`,
        title: `${targetName}: launch`,
        category: "launch",
        passed: false,
        error: target.error.message,
        // `errorCode`, not `code`: the telemetry redactor treats any key
        // normalizing to "code" as a possible OAuth authorization code and
        // keeps only SCREAMING_SNAKE values. The v1 API's launch failures are
        // lowercase snake_case (`billing_limit_reached`, `rate_limited`), so
        // under the shorter name every one of them reached the CI artifact as
        // "[REDACTED]" — the out-of-credits case included.
        details: { errorCode: target.error.code },
      },
    ];
  });
}

function gateReportCase(
  report: GateReport,
  baselineProvenance?: Record<string, unknown>
): StructuredCaseResult {
  const waived = report.outcome === "waived";
  // A WAIVED gate did not block the build, so it must not inflate the
  // artifact's failure count — a JUnit file whose failure count contradicts
  // the exit code sends a CI job red on the strength of the very thing that
  // was waived. It is still not reported as a plain pass: `waiver` below makes
  // the JUnit renderer emit `<skipped>` instead of a bare passing testcase,
  // the HTML renderer give it its own section, and the title say so outright.
  const passed = report.outcome === "passed" || waived;
  return {
    id: "gate",
    title: waived ? "Eval gate (WAIVED)" : "Eval gate",
    category: "gate",
    passed,
    // Only a real FAILED gate is a confirmed regression. `incomplete` and
    // `usage_error` still fail this row (nothing was established either
    // way), but reporting them as `breaking` — the same class a genuine
    // failure gets — would claim a defect the run never observed. Mirrors
    // `gateCase` in sdk/src/run-compare.ts.
    classification:
      report.outcome === "failed"
        ? "breaking"
        // A waived gate is `informational`, NOT `non_breaking`. It really did
        // fail; `non_breaking` would claim the run observed no breaking change,
        // which is the opposite of what happened.
        : waived
          ? "informational"
          : passed
            ? "non_breaking"
            : "informational",
    // The failing verdicts are carried on a WAIVED case too. The waiver
    // explains why the build was not blocked; it is not a reason to stop
    // saying what failed.
    ...(passed && !waived
      ? {}
      : {
          error: report.verdicts
            .filter(
              (verdict) =>
                verdict.status !== "passed" && verdict.status !== "waived"
            )
            .map((verdict) => verdict.message)
            .join("; "),
        }),
    ...(report.waiver
      ? {
          waiver: {
            id: report.waiver.id,
            reason: report.waiver.reason,
            expiresAt: report.waiver.expiresAt,
            createdAt: report.waiver.createdAt,
            createdBy: report.waiver.createdBy,
            createdByEmail: report.waiver.createdByEmail,
            policySnapshot: report.waiver.policySnapshot,
          },
        }
      : {}),
    // The baseline provenance rides along on the case row too, not only in
    // the report's top-level metadata: `--reporter junit-xml` has no other
    // place to carry it, and a regression visible in the exit code but
    // absent from the artifact is a reporting bug.
    details: baselineProvenance
      ? { ...report, baseline: baselineProvenance }
      : report,
  };
}

const DEFAULT_GATE_WAIT_TIMEOUT_MS = 600_000;

async function runEvalGate(
  options: PlatformOptions &
    EvalGateOptions & {
      project?: string;
      /**
       * Optional at the TYPE level only. `gate` cannot mark it required in
       * commander without breaking `gate waive`/`gate unwaive` dispatch, so
       * absence is refused below — with the same exit 2 commander would have
       * produced.
       */
      run?: string;
      wait?: boolean;
      waitTimeout?: string;
      reporter?: string;
      out?: string;
      /**
       * Commander models `--no-gating-score-errors` as the NEGATION of an
       * implicit `--gating-score-errors`, so the field is `gatingScoreErrors`
       * and it is `false` exactly when the user passed the flag. Reading it any
       * other way silently enables the gate on every invocation.
       */
      gatingScoreErrors?: boolean;
    },
  command: Command
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  // Enforced here rather than by commander — see the option's declaration. A
  // usage error, so the exit code is 2 exactly as it was when commander did
  // the checking, and it is raised before any flag parsing spends a request.
  const runId = options.run?.trim();
  if (!runId) {
    throw usageError("--run <id> is required. Pass the eval run to gate.");
  }
  const reporter = parseReporterFormat(options.reporter);
  const needsReport = reporter !== undefined || options.out !== undefined;
  const policy = policyFromOptions({
    ...options,
    noGatingScoreErrors: options.gatingScoreErrors === false,
  });
  // Parsed and validated BEFORE any network call, like `eval compare`'s own
  // policy: a malformed baseline flag exits 2 without spending a request.
  // The NORMALIZED value is what travels downstream — the raw one is never
  // read again, so a whitespace-padded but otherwise valid `--baseline`
  // cannot slip past validation and then fail to resolve on the wire.
  const baseline = resolveBaselineSelector({
    baseline: options.baseline,
    baselineSha: options.baselineSha,
    runId,
  });
  const comparePolicy = comparePolicyFromGateOptions(options);
  const waitTimeoutMs =
    options.waitTimeout !== undefined
      ? parsePositiveInteger(options.waitTimeout, "--wait-timeout")
      : DEFAULT_GATE_WAIT_TIMEOUT_MS;
  const resolved = resolveCloudProjectArgs(options);

  let decisionSummary: EvalRunDecisionSummary | undefined;
  let outcome: {
    report: GateReport;
    run?: PlatformEvalRun;
    iterations?: PlatformEvalIteration[];
    iterationsComplete?: boolean;
    iterationError?: string;
    baselineProvenance?: Record<string, unknown>;
  };
  try {
    outcome = await runPlatformCommand(
      platformOptionsOf(command),
      Math.max(globalOptions.timeout, options.wait ? waitTimeoutMs : 0),
      async ({ client, signal }) => {
        const projects = await client.listProjects({}, { signal });
        const resolution = resolveProject(projects.items, resolved.project);
        if (!resolution.ok) {
          throw usageError(
            appendProjectLinkHint(resolution.message, resolved.projectScope)
          );
        }
        const project = resolution.project;
        const deadline = Date.now() + waitTimeoutMs;
        let run = await client.getEvalRun(
          { projectId: project.id, runId },
          { signal }
        );

        while (!TERMINAL_RUN_STATUSES.has(run.status)) {
          if (!options.wait) {
            // Without --wait, a still-running run would otherwise be gated on
            // its PARTIAL summary — a confident verdict about an unfinished
            // run. Undecidable, not failed.
            decisionSummary = await readEvalRunDecisionSummary(
              client,
              signal,
              project.id,
              run
            );
            return {
              report: {
                outcome: "incomplete" as const,
                scoreIntegrity: "unknown" as const,
                verdicts: [
                  {
                    gate: "run",
                    status: "non_gateable" as const,
                    message: `run is ${run.status}; pass --wait, or gate it once it finishes`,
                  },
                ],
              },
              run,
            };
          }
          if (Date.now() >= deadline) {
            // A wait timeout is INFRASTRUCTURE, not a verdict: the run may yet
            // pass. Reported as incomplete so it can never read as a
            // regression.
            decisionSummary = await readEvalRunDecisionSummary(
              client,
              signal,
              project.id,
              run
            );
            return {
              report: {
                outcome: "incomplete" as const,
                scoreIntegrity: "unknown" as const,
                verdicts: [
                  {
                    gate: "wait",
                    status: "non_gateable" as const,
                    message: `run still ${run.status} after ${waitTimeoutMs}ms`,
                  },
                ],
              },
              run,
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 3000));
          run = await client.getEvalRun(
            { projectId: project.id, runId },
            { signal }
          );
        }

        let iterations:
          | Awaited<ReturnType<typeof fetchAllIterations>>
          | undefined;
        let iterationError: string | undefined;
        if (needsReport || policyNeedsIterations(policy)) {
          try {
            iterations = await fetchAllIterations(
              client,
              signal,
              project.id,
              runId
            );
          } catch (error) {
            iterationError =
              error instanceof Error ? error.message : String(error);
          }
        }

        if (
          isNonVerdictRunStatus(run.status) ||
          isNonVerdictRunResult(run.result)
        ) {
          decisionSummary =
            iterations && iterationError === undefined
              ? decisionSummaryFromIterations({
                  projectId: project.id,
                  run,
                  iterations,
                })
              : await readEvalRunDecisionSummary(
                  client,
                  signal,
                  project.id,
                  run
                );
          // Cancelled / timed out: the run has not told us the server
          // regressed, it has told us nothing. Same for a policy-2
          // `inconclusive` result, where the platform itself declined to
          // decide and its summary counts are the evidence it rejected.
          return {
            report: {
              outcome: "incomplete" as const,
              scoreIntegrity: "unknown" as const,
              verdicts: [
                {
                  gate: "run",
                  status: "non_gateable" as const,
                  message: isNonVerdictRunResult(run.result)
                    ? "run is inconclusive; no verdict was established"
                    : `run is ${run.status}; no verdict was established`,
                },
              ],
            },
            run,
            iterations: iterations?.items ?? [],
            iterationsComplete: iterations?.complete ?? false,
            ...(iterationError ? { iterationError } : {}),
          };
        }

        // Assembled from the walk this gate already paid for, through the
        // canonical assembler. The gate's own verdict is untouched: this
        // EXPLAINS the run, it does not re-decide it, and the summary's verdict
        // comes from the run's own decision rather than from these rows.
        if (iterations) {
          decisionSummary = decisionSummaryFromIterations({
            projectId: project.id,
            run,
            iterations,
          });
        } else {
          // The most common gate — `--min-pass-rate-percent` — is decided off
          // the run's own summary and needs no iteration walk. Read the
          // canonical object for every output mode so JSON and reporter
          // artifacts cannot silently omit it.
          decisionSummary = await readEvalRunDecisionSummary(
            client,
            signal,
            project.id,
            run
          );
        }
        // A failed LOCAL iteration fetch makes the run's own threshold report
        // incomplete, but it says nothing about `/compare`: that endpoint
        // returns its own summary independently, and (absent a latency gate)
        // `evaluateBaselineComparison` never touches these iterations at all.
        // So this is an incomplete THRESHOLD report, not an early return —
        // `--baseline` still gets its chance below, and a real regression
        // there must still merge to `failed` (exit 1) rather than being
        // silently downgraded to `incomplete` (exit 3) by an unrelated fetch
        // hiccup on the other half of the report.
        const thresholdReport = iterationError
          ? {
              outcome: "incomplete" as const,
              scoreIntegrity: "unknown" as const,
              verdicts: [
                {
                  gate: "fetch",
                  status: "non_gateable" as const,
                  message: `could not read the run: ${iterationError}`,
                },
              ],
            }
          : reportForRun(
              run,
              policyNeedsIterations(policy) ? iterations : undefined,
              policy
            );

        // A failed fetch is never "complete", whether or not a report was
        // requested — `!needsReport` is a default for the "nobody asked"
        // case, not for "asked and it broke".
        const iterationsComplete = iterationError
          ? false
          : iterations?.complete ?? !needsReport;

        // Baseline regression gating only makes sense once the run being
        // gated has a verdict of its own; every early return above already
        // skipped this. `--baseline` is optional, so a threshold-only
        // invocation never pays for a `/compare` fetch it did not ask for.
        if (!baseline) {
          return {
            report: thresholdReport,
            run,
            iterations: iterations?.items ?? [],
            iterationsComplete,
            ...(iterationError ? { iterationError } : {}),
          };
        }

        const baselineResult = await evaluateBaselineComparison({
          client,
          signal,
          projectId: project.id,
          runId,
          baseline,
          policy: comparePolicy,
          compareIterations: iterations,
        });

        return {
          report: mergeGateReports(thresholdReport, baselineResult.report),
          run,
          iterations: iterations?.items ?? [],
          iterationsComplete,
          ...(iterationError ? { iterationError } : {}),
          ...(baselineResult.provenance
            ? { baselineProvenance: baselineResult.provenance }
            : {}),
        };
      }
    );
  } catch (error) {
    // A USAGE error (bad project selector, malformed flag) is the author's
    // mistake and keeps its own exit code — mapping it to 3 would tell a CI
    // operator to go looking for an outage that never happened.
    if (
      error instanceof Error &&
      (error as { exitCode?: number }).exitCode === EVAL_GATE_USAGE_EXIT_CODE
    ) {
      throw error;
    }
    // Everything else — network, auth, timeout — is infrastructure. NEVER exit
    // 1: a CI job that fails a release on a flaked request, and calls it a
    // regression, teaches people to ignore the gate.
    const detail = error instanceof Error ? error.message : String(error);
    const report: GateReport = {
      outcome: "incomplete",
      scoreIntegrity: "unknown",
      verdicts: [
        {
          gate: "fetch",
          status: "non_gateable",
          message: `could not read the run: ${detail}`,
        },
      ],
    };
    // `--reporter`/`--out` still need to be honored on an infrastructure
    // failure: a CI step expecting the reporter-selected artifact must not
    // find raw JSON on stdout, or find `--out` never written at all.
    const structured = needsReport
      ? buildEvalRunReport([], {
          cases: [gateReportCase(report)],
          verdict: gateOutcomeVerdict(report.outcome),
        })
      : undefined;
    if (options.out && structured) {
      await writeReporterArtifact(
        options.out,
        reporter ?? "json-summary",
        structured
      );
    }
    if (reporter && structured) {
      writeReporterResult(reporter, structured);
    } else {
      writeResult(
        { gate: report, exitCode: EVAL_GATE_INCOMPLETE_EXIT_CODE },
        globalOptions.format
      );
    }
    setProcessExitCode(EVAL_GATE_INCOMPLETE_EXIT_CODE);
    return;
  }

  // THE WAIVER, folded in after every verdict is settled and before anything
  // is reported.
  //
  // HERE rather than inside the fetch closure, because this must also cover
  // the early returns above (a still-running run, a wait timeout, a cancelled
  // run) — and it must cover them by NOT waiving them: `applyGateWaiver`
  // upgrades only a real `failed` outcome, so an infrastructure condition
  // keeps its exit 3 no matter what waiver is on the run. A waiver granted
  // because the evals regressed is not consent to ship on a network error.
  //
  // The waiver is attached even when it changed nothing, so the artifact names
  // it either way. `outcome` is the only thing that says whether it decided
  // anything.
  const report = applyGateWaiver(
    outcome.report,
    activeWaiverForRun(outcome.run)
  );
  const exitCode = evalGateExitCode(report);
  const structured = needsReport
    ? buildEvalRunReport(
        outcome.run
          ? [
              {
                run: outcome.run,
                iterations: outcome.iterations ?? [],
                iterationsComplete: outcome.iterationsComplete ?? false,
                ...(outcome.iterationError
                  ? { iterationError: outcome.iterationError }
                  : {}),
              },
            ]
          : [],
        {
          cases: [gateReportCase(report, outcome.baselineProvenance)],
          verdict: gateOutcomeVerdict(report.outcome),
          ...(decisionSummary ? { decisionSummary } : {}),
          ...(outcome.baselineProvenance
            ? { metadata: { baselineComparison: outcome.baselineProvenance } }
            : {}),
        }
      )
    : undefined;
  if (options.out && structured) {
    await writeReporterArtifact(
      options.out,
      reporter ?? "json-summary",
      structured
    );
  }
  if (reporter && structured) {
    writeReporterResult(reporter, structured);
  } else {
    writeResult(
      globalOptions.format === "json"
        ? {
            gate: report,
            exitCode,
            ...(decisionSummary ? { decisionSummary } : {}),
          }
        : { gate: report, exitCode },
      globalOptions.format
    );
  }
  if (globalOptions.format === "human" && !reporter) {
    process.stderr.write(`${formatGateReport(report)}\n`);
    writeEvalDecisionSummary(
      globalOptions.format,
      decisionSummary,
      process.stderr
    );
  }
  if (exitCode !== 0) {
    setProcessExitCode(exitCode);
  }
}

/**
 * Read `--run` and `--project` off the parent `gate` command.
 *
 * They are declared on `gate`, and commander hands a parent's options to the
 * parent's own `opts()` even when a subcommand is the one running — so the
 * subcommand must ask upward rather than redeclare them. Redeclaring is worse
 * than verbose: the parent consumes `--run` first, and the subcommand's own
 * mandatory check then fails on a flag the user demonstrably passed.
 *
 * `--run` is enforced HERE, with a usage error, because `gate` can no longer
 * mark it required (see the registration). Exit 2 either way.
 */
function gateSubcommandScope(command: Command): {
  run: string;
  project?: string;
} {
  const parentOptions = (command.parent?.opts() ?? {}) as {
    run?: string;
    project?: string;
  };
  const run = parentOptions.run?.trim();
  if (!run) {
    throw usageError("--run <id> is required. Pass the eval run to act on.");
  }
  return {
    run,
    ...(parentOptions.project !== undefined
      ? { project: parentOptions.project }
      : {}),
  };
}

/**
 * `mcpjam cloud eval gate waive` — override a failing run's gate, on the
 * record.
 *
 * The notice goes to STDERR before the request, not after and not on stdout.
 * Before, because it is a warning about what the caller is ABOUT to store
 * permanently and unredacted; stderr, so `--format json` output stays one
 * parseable document.
 *
 * NO LOCAL VALIDATION of the reason or the expiry beyond parsing the duration
 * format. Each of the platform's five refusals carries copy it wrote for the
 * caller — including the one for a suite with no organization, which names a
 * remedy nobody would guess — and a local check firing first would replace
 * that copy with a message invented here.
 */
async function runEvalGateWaive(
  options: { reason: string; expiresIn: string },
  command: Command
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const scope = gateSubcommandScope(command);
  // Parsed BEFORE any network call, like every other flag in this file: a
  // malformed duration exits 2 without spending a request.
  const expiresAt = parseWaiverExpiry(options.expiresIn);
  const resolved = resolveCloudProjectArgs(scope);

  if (globalOptions.format === "human") {
    process.stderr.write(`Gate waiver reason: ${GATE_WAIVER_REASON_NOTICE}\n`);
  }

  const result = await runPlatformCommand(
    platformOptionsOf(command),
    globalOptions.timeout,
    async ({ client, signal }) => {
      const projects = await client.listProjects({}, { signal });
      const resolution = resolveProject(projects.items, resolved.project);
      if (!resolution.ok) {
        throw usageError(
          appendProjectLinkHint(resolution.message, resolved.projectScope)
        );
      }
      return await client.createGateWaiver(
        {
          projectId: resolution.project.id,
          runId: scope.run,
          reason: options.reason,
          expiresAt,
        },
        { signal }
      );
    }
  );

  writeResult(result, globalOptions.format);
  if (globalOptions.format === "human") {
    // `conflict` is a normal result, not an error, and it must not read as
    // "granted" — the waiver now in force is somebody else's, with somebody
    // else's reason on the check.
    process.stderr.write(
      `${
        result.status === "conflict"
          ? "A waiver was already in force over this run; it was NOT replaced."
          : "Gate waived."
      } ${formatGateWaiverLine(result.waiver)}\n`
    );
    // A published Check Run is a persisted verdict, not a live read. Zero
    // republished checks on a repository with checks connected means the
    // status that actually gates the merge did not move — worth saying, since
    // that is usually the reason someone waived at all.
    process.stderr.write(
      `Republished ${result.republishedChecks} GitHub check run(s).\n`
    );
  }
}

/**
 * `mcpjam cloud eval gate unwaive` — end a waiver early.
 *
 * `--waiver` is optional: omitted, the waiver currently in force over `--run`
 * is resolved first. That read is what makes the common case safe as well as
 * convenient — revoking "the waiver on this run" cannot name the wrong row.
 *
 * `already_revoked` is a SUCCESS. The platform reports the original
 * revocation rather than restamping it, so a retry cannot overwrite the record
 * of who actually ended the waiver; treating it as an error here would push
 * callers into exactly the retry loop that record has to survive.
 */
async function runEvalGateUnwaive(
  options: { waiver?: string },
  command: Command
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const scope = gateSubcommandScope(command);
  const resolved = resolveCloudProjectArgs(scope);

  const result = await runPlatformCommand(
    platformOptionsOf(command),
    globalOptions.timeout,
    async ({ client, signal }) => {
      const projects = await client.listProjects({}, { signal });
      const resolution = resolveProject(projects.items, resolved.project);
      if (!resolution.ok) {
        throw usageError(
          appendProjectLinkHint(resolution.message, resolved.projectScope)
        );
      }
      const projectId = resolution.project.id;

      let waiverId = options.waiver?.trim();
      if (!waiverId) {
        const { waiver } = await client.getGateWaiver(
          { projectId, runId: scope.run },
          { signal }
        );
        if (!waiver) {
          // A usage error, not a silent success. "Nothing to revoke" and "I
          // revoked it" are different facts, and an operator putting a gate
          // back needs to know which one happened. Naming `--waiver` says how
          // to reach an already-expired or already-revoked row, which this
          // read deliberately does not return.
          throw usageError(
            `No waiver is in force over run "${scope.run}". Pass --waiver <id> to revoke a specific one.`
          );
        }
        waiverId = waiver.id;
      }

      return await client.revokeGateWaiver(
        { projectId, runId: scope.run, waiverId },
        { signal }
      );
    }
  );

  writeResult(result, globalOptions.format);
  if (globalOptions.format === "human") {
    process.stderr.write(
      `${
        result.status === "already_revoked"
          ? "This waiver was already revoked; the existing revocation stands."
          : "Gate waiver revoked."
      } Republished ${result.republishedChecks} GitHub check run(s).\n`
    );
  }
}

/**
 * `mcpjam cloud eval compare` — this run against a baseline.
 *
 * Deliberately has NO `--wait`. A comparison against a run that has not
 * finished compares against a partial population, and the honest answer is
 * incomplete (exit 3), not "wait around and hope". `eval gate --wait` exists
 * for the waiting.
 */
async function runEvalCompare(
  options: PlatformOptions &
    EvalCompareOptions & {
      project?: string;
      run: string;
      baseRun?: string;
      baseSha?: string;
      reporter?: string;
      out?: string;
    },
  command: Command
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  // Parsed BEFORE any network call, so a malformed flag exits 2 without
  // spending a request — and cannot be mistaken for an infrastructure failure.
  const policy = comparePolicyFromOptions(options);
  // Same pre-network parse, and the same mutual exclusion the route and the
  // Convex action enforce. `eval compare` has NO required baseline — omitting
  // both selectors is the documented "nearest earlier completed run" default —
  // so this only refuses the pair, and normalizes whichever one was given.
  const baseSelector = compareBaseSelector({
    baseRun: options.baseRun,
    baseSha: options.baseSha,
  });
  const reporter = parseReporterFormat(options.reporter);
  const resolved = resolveCloudProjectArgs(options);

  type CompareOutcome = {
    report: GateReport;
    compare?: PlatformRunCompare;
    flakyCases?: FlakyCase[];
    decisionSummary?: EvalRunDecisionSummary;
  };

  let outcome: CompareOutcome;
  try {
    outcome = await runPlatformCommand(
      platformOptionsOf(command),
      globalOptions.timeout,
      async ({ client, signal }) => {
        const projects = await client.listProjects({}, { signal });
        const resolution = resolveProject(projects.items, resolved.project);
        if (!resolution.ok) {
          throw usageError(
            appendProjectLinkHint(resolution.message, resolved.projectScope)
          );
        }
        const project = resolution.project;

        const compare = await client.compareEvalRun(
          {
            projectId: project.id,
            runId: options.run,
            ...baseSelector,
          },
          { signal }
        );

        // Latency and flakiness both need per-iteration rows. An INCOMPLETE
        // walk contributes neither: a p95 over page one is not this run's p95,
        // and a flaky-case list from a sample is misleading rather than
        // partial.
        const needsIterations =
          policy.maximumP95LatencyIncreaseMs !== undefined;
        const [baseIterations, compareIterations] = needsIterations
          ? await Promise.all([
              fetchAllIterations(
                client,
                signal,
                project.id,
                compare.baseRun.id
              ),
              fetchAllIterations(
                client,
                signal,
                project.id,
                compare.compareRun.id
              ),
            ])
          : [
              undefined,
              await fetchAllIterations(
                client,
                signal,
                project.id,
                compare.compareRun.id
              ),
            ];

        // Defence in depth. The backend action already refuses a
        // non-completed run, so this is normally unreachable — but the
        // command's contract says an unfinished comparison is INCOMPLETE, and
        // that must not depend on a guard in another repo staying put.
        if (
          compare.baseRun.completedAt === null ||
          compare.compareRun.completedAt === null
        ) {
          return {
            report: {
              outcome: "incomplete" as const,
              scoreIntegrity: "unknown" as const,
              verdicts: [
                {
                  gate: "run",
                  status: "non_gateable" as const,
                  message:
                    "both runs must be completed before they can be compared",
                },
              ],
            },
            compare,
            flakyCases: [],
          };
        }

        const input = compareGateInputFrom(compare, {
          baseP95Ms: p95Of(baseIterations),
          compareP95Ms: p95Of(compareIterations),
        });

        // The compare wire's run sides are a COMPARISON projection: they carry
        // `result` and `summary` but no `status` and no `verdictSummary`, so
        // assembling a decision from one would report a policy-v2 run as a
        // legacy percent-threshold run — a claim about where its verdict came
        // from that would simply be false. One small read gets the real thing;
        // the diagnostics still come from the walk already performed, which is
        // more complete than a single endpoint page.
        const compareRunDetail = await client
          .getEvalRun(
            { projectId: project.id, runId: compare.compareRun.id },
            { signal }
          )
          .catch(() => undefined);

        return {
          report: evaluateCompareGates(input, policy),
          compare,
          // About the COMPARE side only. A baseline's own failures are a
          // different run's diagnostics and would read here as this run's.
          decisionSummary:
            compareIterations && compareRunDetail
              ? decisionSummaryFromIterations({
                  projectId: project.id,
                  run: compareRunDetail,
                  iterations: compareIterations,
                })
              : undefined,
          // Reported, NEVER gated. See `detectFlakyCases`.
          flakyCases: compareIterations?.complete
            ? detectFlakyCases(flakyInputFrom(compareIterations.items))
            : [],
        };
      }
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error as { exitCode?: number }).exitCode === EVAL_GATE_USAGE_EXIT_CODE
    ) {
      throw error;
    }
    // A missing baseline is INCOMPLETE, not a failure: the run may be a
    // suite's first, and reporting exit 1 would claim a regression nobody
    // observed. Keyed on `details.reason` rather than the message, which is
    // prose and may be localized or reworded.
    const reason = baselineNotFoundReason(error);
    const detail = error instanceof Error ? error.message : String(error);
    const report: GateReport = {
      outcome: "incomplete",
      scoreIntegrity: "unknown",
      verdicts: [
        {
          gate: reason ? "baseline" : "fetch",
          status: "non_gateable",
          message: reason
            ? `no baseline to compare against: ${detail}`
            : `could not compare the runs: ${detail}`,
        },
      ],
    };
    // A reporter was requested, so CI is parsing the output — handing it the
    // default JSON instead of JUnit on the error path is how a pipeline
    // silently stops seeing results.
    await writeCompareResult(
      { report, reporter, out: options.out, format: globalOptions.format },
      // Built whenever EITHER output channel was requested. `--reporter` needs
      // it to emit JUnit rather than JSON; `--out` needs it so a CI step
      // reading the artifact finds the verdict instead of a missing file.
      reporter || options.out ? emptyCompareReport(report) : undefined
    );
    setProcessExitCode(EVAL_GATE_INCOMPLETE_EXIT_CODE);
    return;
  }

  const exitCode = evalGateExitCode(outcome.report);
  await writeCompareResult(
    {
      report: outcome.report,
      reporter,
      out: options.out,
      format: globalOptions.format,
    },
    outcome.compare
      ? buildRunCompareReport(outcome.compare, outcome.report, {
          flakyCases: outcome.flakyCases,
          decisionSummary: outcome.decisionSummary,
        })
      : undefined
  );
  if (globalOptions.format === "human" && !reporter) {
    process.stderr.write(`${formatGateReport(outcome.report)}\n`);
    // The COMPARE side's own decision, the same object the report carries.
    // Stderr, like the gate report above, so `--format human` still leaves one
    // parseable document on stdout. The baseline's failures are a different
    // run's diagnostics and are deliberately not shown here.
    writeEvalDecisionSummary(
      globalOptions.format,
      outcome.decisionSummary,
      process.stderr
    );
  }
  if (exitCode !== 0) {
    setProcessExitCode(exitCode);
  }
}

/**
 * `mcpjam cloud eval pull` — materialize a hosted suite into a local corpus lock.
 *
 * Two modes, one code path. The default fetches and WRITES the lock; `--frozen`
 * fetches and only COMPARES, never writing. Sharing the fetch and
 * materialization matters: a `--frozen` check that built its corpus differently
 * from the pull that wrote the lock would report drift that does not exist.
 *
 * Exit codes follow the contract in `corpus-lock.ts`: 0 clean, 1 drift (the one
 * real verdict this command can reach), 2 a flag or a case this CLI cannot run,
 * 3 anything that means no comparison happened.
 */
async function runEvalPull(
  options: PlatformOptions & {
    suite: string;
    project?: string;
    lock?: string;
    frozen?: boolean;
    skipUnsupported?: boolean;
  },
  command: Command
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const lockPath = resolveCorpusLockPath(options.lock);
  const resolved = resolveCloudProjectArgs(options);

  // Read the existing lock BEFORE fetching. A `--frozen` run with no lock is
  // exit 3 whatever the server would have said, and discovering that after a
  // round trip only delays the answer.
  const locked = options.frozen ? await readCorpusLock(lockPath) : undefined;

  let fetched: {
    suite: { id: string; name?: string };
    cases: PlatformEvalCase[];
    suiteChecks: unknown[];
    suiteMatchOptions?: PublicMatchOptions;
  };
  try {
    fetched = await runPlatformCommand(
      platformOptionsOf(command),
      globalOptions.timeout,
      async ({ client, signal }) => {
        const selector = {
          ...(resolved.project !== undefined
            ? { project: resolved.project }
            : {}),
          suite: options.suite,
        };
        const [detail, page] = await Promise.all([
          getEvalSuiteOperation.execute(selector, { client, signal }),
          listEvalCasesOperation.execute(selector, { client, signal }),
        ]);

        // The cases endpoint returns the whole suite today and the client has
        // no cursor parameter to follow one with. If that ever changes, a
        // silently truncated corpus would be locked as if complete — so this
        // refuses rather than guessing. Fail-closed: a partial lock is worse
        // than no lock.
        if (page.nextCursor) {
          throw cliError(
            "CORPUS_TRUNCATED",
            `Suite "${options.suite}" returned more cases than one page and ` +
              `this CLI cannot follow the cursor. Upgrade @mcpjam/cli.`,
            CORPUS_INCOMPLETE_EXIT_CODE
          );
        }

        return {
          suite: {
            id: detail.id,
            ...(detail.name ? { name: detail.name } : {}),
          },
          cases: page.items,
          suiteChecks: detail.settings.checks ?? [],
          ...(detail.settings.matchOptions
            ? { suiteMatchOptions: detail.settings.matchOptions }
            : {}),
        };
      },
      { projectScope: resolved.projectScope }
    );
  } catch (error) {
    throw corpusFetchFailure(error);
  }

  let corpus: LoadedCorpus;
  try {
    corpus = buildCorpus({
      ...(resolved.project !== undefined ? { project: resolved.project } : {}),
      suite: fetched.suite,
      cases: fetched.cases,
      suiteChecks: fetched.suiteChecks,
      ...(fetched.suiteMatchOptions
        ? { suiteMatchOptions: fetched.suiteMatchOptions }
        : {}),
      unsupported: options.skipUnsupported ? "skip" : "error",
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    // A case this CLI cannot execute is the user's to resolve — by fixing the
    // case, or by opting into `--skip-unsupported`. It is emphatically NOT
    // exit 1: nothing regressed. Nor exit 3: the fetch succeeded and the
    // answer is definite.
    if (error instanceof HostedOnlyCaseError) {
      throw cliError(
        "CORPUS_HOSTED_ONLY_CASE",
        `${error.message} Pass --skip-unsupported to omit cases like this ` +
          `from the corpus and the lock.`,
        CORPUS_USAGE_EXIT_CODE,
        { caseId: error.caseId, caseTitle: error.caseTitle }
      );
    }
    throw cliError(
      "CORPUS_INVALID_CASE",
      error instanceof Error ? error.message : String(error),
      CORPUS_USAGE_EXIT_CODE
    );
  }

  const summary = {
    suite: corpus.suite,
    cases: corpus.cases.length,
    skipped: corpus.skipped,
    evaluationConfigHash: corpus.lock.evaluationConfigHash,
  };

  if (locked) {
    const drift = verifyCorpusLock(locked, corpus.lock);
    writeResult(
      { ...summary, lockPath, frozen: true, drift },
      globalOptions.format
    );
    if (globalOptions.format === "human") {
      process.stderr.write(`${renderCorpusDrift(drift)}\n`);
    }
    if (drift.length > 0) {
      setProcessExitCode(CORPUS_DRIFT_EXIT_CODE);
    }
    return;
  }

  const written = await writeCorpusLockAtomic(lockPath, corpus.lock);
  writeResult(
    { ...summary, lockPath: written, written: true },
    globalOptions.format
  );
}

/**
 * A structured report for a comparison that never happened.
 *
 * The gate case alone, so `--reporter junit-xml` still emits well-formed XML
 * whose single failure explains why — rather than an empty suite, which every
 * CI UI renders as "nothing ran".
 */
function emptyCompareReport(report: GateReport): StructuredRunReport {
  return buildRunCompareReport(
    {
      suite: { id: "", name: "" },
      baseline: { policy: "previous_completed", baseRunId: "" },
      baseRun: {
        id: "",
        runNumber: 0,
        result: "",
        createdAt: 0,
        completedAt: null,
        summary: null,
      },
      compareRun: {
        id: "",
        runNumber: 0,
        result: "",
        createdAt: 0,
        completedAt: null,
        summary: null,
      },
      passSummary: {
        passRatePercent: EMPTY_DIFF,
        total: EMPTY_DIFF,
        passed: EMPTY_DIFF,
        failed: EMPTY_DIFF,
      },
      metrics: {
        wallDurationMs: EMPTY_DIFF,
        totalTokens: EMPTY_DIFF,
        estimatedCostUsd: EMPTY_DIFF,
      },
      scoreContract: {
        base: {
          evaluationConfigHash: null,
          scoreIntegrity: null,
          scoredIterations: 0,
          quarantinedIterations: 0,
        },
        compare: {
          evaluationConfigHash: null,
          scoreIntegrity: null,
          scoredIterations: 0,
          quarantinedIterations: 0,
        },
        evaluationConfigChanged: false,
        scorers: [],
      },
      cases: [],
    },
    report
  );
}

const EMPTY_DIFF = {
  base: null,
  compare: null,
  delta: null,
  percentDelta: null,
};

async function writeCompareResult(
  args: {
    report: GateReport;
    reporter: ReturnType<typeof parseReporterFormat>;
    out?: string;
    format: ReturnType<typeof getGlobalOptions>["format"];
  },
  structured: StructuredRunReport | undefined
): Promise<void> {
  if (args.out && structured) {
    // `--out` and `--reporter` are two terminals for the same artifact: the
    // file gets whichever format `--reporter` selected (json-summary by
    // default), same as `eval run`/`eval gate`, not always raw JSON.
    await writeReporterArtifact(args.out, args.reporter ?? "json-summary", structured);
  }
  if (args.reporter && structured) {
    writeReporterResult(args.reporter, structured);
    return;
  }
  writeResult(
    { compare: args.report, exitCode: evalGateExitCode(args.report) },
    args.format
  );
}

// ── suite files ──────────────────────────────────────────────────────────────

/**
 * Exit codes for `eval validate`, spelled out because the difference between
 * them is the whole point of the command.
 *
 * 1 means the file was READ AND JUDGED and it is invalid. 2 means nothing was
 * judged — the path was wrong, the input was over the cap, the YAML was
 * malformed. A script that retries on 2 and opens a ticket on 1 is doing the
 * right thing with both.
 */
const SUITE_FILE_INVALID_EXIT_CODE = 1;
/**
 * Nothing was judged. The same code `usageError` carries (`lib/output.ts`),
 * named here so the two suite-file commands do not borrow the eval GATE's
 * constant for a thing that has nothing to do with a gate.
 */
const SUITE_FILE_USAGE_EXIT_CODE = 2;

/**
 * Read `--file`, keeping the file's REAL byte count.
 *
 * The bytes are what the 1 MiB cap is about, and a string re-encoded from a
 * file that was not valid UTF-8 does not have the same length as the file. So
 * the buffer's length travels with the text rather than being re-derived from
 * it.
 */
function readSuiteFileInput(value: string): {
  text: string;
  bytes: number;
  buffer: Buffer;
} {
  try {
    const buffer = value === "-" ? readFileSync(0) : readFileSync(value);
    return {
      text: buffer.toString("utf8"),
      bytes: buffer.byteLength,
      buffer,
    };
  } catch (error) {
    throw usageError(
      value === "-"
        ? "Failed to read the suite file from stdin."
        : `Failed to read the suite file "${value}".`,
      { source: error instanceof Error ? error.message : String(error) }
    );
  }
}

/** The `--format json` envelope. Pinned: `docs/cli/reference.mdx` repeats it. */
type ValidateResult = {
  valid: boolean;
  file: string;
  /** Absent when valid. `contract` is exit 1; `input`/`parse` are exit 2. */
  stage?: SuiteFileFailureStage;
  suite?: {
    id: string;
    name: string;
    cases: number;
    enabledCases: number;
  };
  findings: unknown[];
  /**
   * Present ONLY when `--project` was passed.
   *
   * A separate block rather than more entries in `findings`, because the two
   * answer different questions: `findings` is "is this a valid suite file?",
   * which is a property of the bytes and reproducible on any machine, and this
   * is "does it resolve against THIS project right now?", which is a property
   * of a live inventory that changes under you. Merging them would make a
   * caller unable to tell a file it must edit from a project it must fix.
   */
  projectValidation?: {
    project: { id: string; name: string };
    /** Every target the file resolved to, so a finding's scope is readable. */
    targets: string[];
    valid: boolean;
    findings: ImportToolFinding[];
  };
};

/**
 * Validate a suite file offline.
 *
 * NO auth, NO network, NO project: this command builds no platform client,
 * reads no API key and resolves no project, which is why it takes no
 * `--project`. It answers "is this file well-formed and contract-valid?" and
 * nothing else.
 *
 * What it deliberately does NOT answer: whether the tool names, server
 * references and fixtures a case mentions exist in some project. That
 * re-resolution against live discovery is project-aware validation, it needs a
 * network round trip, and it is a later step's work. "Valid" here therefore
 * means "a valid suite file", never "this will run".
 */
/**
 * Findings from a live check, rendered the way `formatSuiteFileFindings`
 * renders structural ones — same pointer-first shape, so a reader scanning both
 * halves of a `--project` validation is reading one format, not two.
 */
export function formatImportToolFindings(
  findings: readonly ImportToolFinding[]
): string {
  return findings
    .map(
      (entry) =>
        `  ${entry.pointer}: ${entry.message} ` +
        `(case ${entry.caseId}${entry.disabled ? ", disabled" : ""}` +
        `${entry.imported ? ", imported" : ""})`
    )
    .join("\n");
}

/**
 * The live half of `eval validate --project`.
 *
 * Authenticates and resolves the named project with the same helpers every
 * other cloud command uses, then runs the ONE shared reference check. A failure
 * to authenticate, reach the project, or list a server's tools propagates as a
 * command error: the file has not been judged, and saying it has would be a
 * lie in the one direction that matters.
 */
async function runProjectValidation(
  options: PlatformOptions & { project?: string },
  command: Command,
  resolved: ResolvedEvalSuiteFile
): Promise<NonNullable<ValidateResult["projectValidation"]>> {
  const globalOptions = getGlobalOptions(command);
  const scope = resolveCloudProjectArgs(options);
  return runPlatformCommand(
    platformOptionsOf(command),
    globalOptions.timeout,
    async ({ client, signal }) => {
      const page = await client.listProjects({}, { signal });
      const resolution = resolveProject(page.items, scope.project);
      if (!resolution.ok) throw projectResolutionError(resolution.message);
      const project = resolution.project;
      const outcome = await validateImportToolReferences(client, {
        projectId: project.id,
        resolved,
        signal,
      });
      return {
        project: { id: project.id, name: project.name },
        targets: outcome.targets.map((target) => target.label),
        valid: outcome.findings.length === 0,
        findings: outcome.findings,
      };
    }
  );
}

async function runEvalValidate(
  options: PlatformOptions & { file: string; project?: string },
  command: Command
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const source = readSuiteFileInput(options.file);
  const label = options.file === "-" ? "<stdin>" : options.file;
  const loaded = loadEvalSuiteFile(source.text, { byteLength: source.bytes });

  if (loaded.ok) {
    // Keyed off the FLAG, never off the resolved project scope. A linked
    // directory or an `MCPJAM_PROJECT` in the environment must not silently
    // turn the one offline command in this CLI into a networked one —
    // somebody validating a file on a plane would get an auth error for a
    // question that needs no auth.
    const projectValidation =
      options.project === undefined
        ? undefined
        : await runProjectValidation(options, command, loaded.resolved);
    const result: ValidateResult = {
      valid: projectValidation ? projectValidation.valid : true,
      file: label,
      suite: {
        id: loaded.authored.suite.id,
        name: loaded.authored.suite.name,
        cases: loaded.resolved.cases.length,
        enabledCases: loaded.resolved.enabledCases.length,
      },
      findings: [],
      ...(projectValidation ? { projectValidation } : {}),
    };
    if (globalOptions.format === "human") {
      const total = result.suite?.cases ?? 0;
      process.stdout.write(
        `${label}: ${result.valid ? "valid" : "invalid"} — suite ${result.suite?.id} ` +
          `(${total} ${total === 1 ? "case" : "cases"}, ` +
          `${result.suite?.enabledCases} enabled)\n`
      );
      if (projectValidation && !projectValidation.valid) {
        process.stdout.write(
          `${projectValidation.findings.length} unresolved reference(s) ` +
            `against project ${projectValidation.project.name}:\n` +
            formatImportToolFindings(projectValidation.findings) +
            "\n"
        );
      }
    } else {
      writeResult(result, globalOptions.format);
    }
    // A completed live check that found unresolved references is a VERDICT on
    // the file, so it takes the command's ordinary "file judged invalid" exit.
    // An auth or network failure never reaches here — it threw, and threw as a
    // command error.
    if (projectValidation && !projectValidation.valid) {
      setProcessExitCode(SUITE_FILE_INVALID_EXIT_CODE);
    }
    return;
  }

  // Annotated, like the success envelope above: the shape is pinned in
  // `docs/cli/reference.mdx`, and an unannotated literal can drift from it
  // without the compiler noticing.
  const result: ValidateResult = {
    valid: false,
    file: label,
    stage: loaded.stage,
    findings: [...loaded.findings],
  };
  if (globalOptions.format === "human") {
    process.stdout.write(
      `${label}: invalid (${loaded.findings.length} ${
        loaded.findings.length === 1 ? "finding" : "findings"
      })\n${formatSuiteFileFindings(loaded.findings)}\n`
    );
  } else {
    writeResult(result, globalOptions.format);
  }

  // Exit 1 only when the file PARSED and lost on the contract. Everything else
  // means no verdict was reached, and reporting that as "your file is invalid"
  // sends someone to edit a file whose problem is its size or its syntax.
  setProcessExitCode(
    loaded.stage === "contract"
      ? SUITE_FILE_INVALID_EXIT_CODE
      : SUITE_FILE_USAGE_EXIT_CODE
  );
}

/**
 * Fetch a hosted suite and write it as a suite file — or write nothing.
 *
 * The fetch is the SAME operation pair `eval pull` uses, including its
 * fail-closed pagination guard: a suite whose cases do not fit one page refuses
 * rather than exporting a file that silently holds fewer tests than the suite.
 */
async function runEvalExport(
  options: PlatformOptions & {
    suite: string;
    project?: string;
    out?: string;
    force?: boolean;
  },
  command: Command
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const resolved = resolveCloudProjectArgs(options);

  // Checked BEFORE the fetch when the caller named the path: refusing to
  // overwrite is not worth a round trip. With no `--out` the path is derived
  // from the suite's id, so that check has to wait until it is known.
  if (options.out !== undefined) {
    refuseToOverwrite(options.out, options.force === true);
  }

  const fetched = await runPlatformCommand(
    platformOptionsOf(command),
    globalOptions.timeout,
    async ({ client, signal }) => {
      const selector = {
        ...(resolved.project !== undefined
          ? { project: resolved.project }
          : {}),
        suite: options.suite,
      };
      const [detail, page] = await Promise.all([
        getEvalSuiteOperation.execute(selector, { client, signal }),
        listEvalCasesOperation.execute(selector, { client, signal }),
      ]);

      // Same guard as `eval pull`, same reason: the cases endpoint returns the
      // whole suite today and the client has no cursor to follow. A truncated
      // export is a file that describes a smaller suite than the one it names.
      if (page.nextCursor) {
        throw cliError(
          "SUITE_FILE_TRUNCATED",
          `Suite "${options.suite}" returned more cases than one page and this ` +
            `CLI cannot follow the cursor. Upgrade @mcpjam/cli.`,
          SUITE_FILE_USAGE_EXIT_CODE
        );
      }

      let environment: PlatformEnvironmentResolved | undefined;
      const environmentIds = detail.environmentIds ?? [];
      const legacyServers = detail.environment?.servers ?? [];
      if (environmentIds.length === 1 && legacyServers.length === 0) {
        environment = await resolveEnvironmentOperation.execute(
          {
            project: detail.projectId ?? resolved.project,
            environment: environmentIds[0]!,
          },
          { client, signal }
        );
      }

      return {
        detail,
        cases: page.items,
        ...(environment ? { environment } : {}),
      };
    },
    { projectScope: resolved.projectScope }
  );

  const built = buildSuiteFileFromPlatform(fetched);
  if (!built.ok) {
    writeExportRefusal(built.findings, globalOptions.format);
    return;
  }

  const text = serializeEvalSuiteFile(built.file);

  // Over the cap is a REFUSAL, not a bug. Nothing in the contract bounds a
  // suite's total size — 500 cases and an unbounded `expectedOutput` are all
  // legal — so a suite that serializes past the limit is a representability
  // answer like any other, and reporting it through the round-trip assertion
  // below would tell the author to file a CLI bug about their own suite.
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SUITE_FILE_BYTES) {
    writeExportRefusal(
      [suiteFileTooLarge(bytes, MAX_SUITE_FILE_BYTES)],
      globalOptions.format
    );
    return;
  }

  // The round trip is asserted HERE, not only in tests. A serializer that
  // loses a field is a file that runs a different suite than the dashboard
  // does, and the bytes about to be written are the only thing that can prove
  // it did not happen for THIS suite.
  const reloaded = loadEvalSuiteFile(text, { byteLength: bytes });
  if (!reloaded.ok || !isDeepStrictEqual(reloaded.authored, built.file)) {
    throw operationalError(
      `The suite file written for "${built.file.suite.id}" does not read back ` +
        `identically, so nothing was written. This is a bug in @mcpjam/cli — ` +
        `please report it.`,
      reloaded.ok ? undefined : { findings: reloaded.findings }
    );
  }

  const outPath = options.out ?? defaultSuiteFilePath(built.file.suite.id);
  if (options.out === undefined) {
    refuseToOverwrite(outPath, options.force === true);
  }
  const written = await writeFileAtomic(outPath, text, { createParents: true });

  writeResult(
    {
      exported: true,
      path: written,
      suite: { id: built.file.suite.id, name: built.file.suite.name },
      cases: built.file.cases.length,
      bytes,
    },
    globalOptions.format
  );
}

/** Refuse to replace a file the caller did not ask to replace. */
function refuseToOverwrite(outPath: string, force: boolean): void {
  if (force || !existsSync(outPath)) return;
  throw usageError(
    `"${outPath}" already exists. Pass --force to replace it, or --out to ` +
      `write somewhere else.`
  );
}

/**
 * Report a suite that cannot be represented, and write NOTHING.
 *
 * A verdict, not a crash — the command did its job and the answer is "this
 * suite does not fit the format". Same shape as `eval pull --frozen`'s drift
 * report: the finding list goes to stdout so a script can read it, and the
 * exit code says the export did not happen.
 */
function writeExportRefusal(
  findings: SuiteExportFinding[],
  format: ReturnType<typeof getGlobalOptions>["format"]
): void {
  if (format === "human") {
    process.stdout.write(
      `Nothing was written: this suite cannot be represented as a suite file ` +
        `(${findings.length} ${
          findings.length === 1 ? "reason" : "reasons"
        }).\n` +
        findings
          .map((entry) =>
            entry.pointer === ""
              ? `  ${entry.code} ${entry.message}`
              : `  ${entry.code} ${entry.pointer}: ${entry.message}`
          )
          .join("\n") +
        "\n"
    );
  } else {
    writeResult({ exported: false, path: null, findings }, format);
  }
  setProcessExitCode(SUITE_FILE_INVALID_EXIT_CODE);
}

export function registerEvalCommands(program: Command): void {
  const evals = program
    .command("eval")
    .description("Author and run eval suites in your hosted MCPJam projects");

      evals
      .command("create")
      .description(
        "Create a runnable eval suite from authored test cases (does not run it)"
      )
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
      .option(
        "--file <path>",
        "Path to a create-API JSON body (or - for stdin). A versioned suite file belongs on `eval run --file`"
      )
      .option(
        "--json <json>",
        "Inline suite definition JSON (or @file, or - for stdin)"
      )
      .option("--name <name>", "Suite name (overrides the file)")
      .option(
        "--model <model>",
        "Suite-level default model (overrides the file)"
      )
      .option(
        "--provider <provider>",
        "Suite-level default provider (overrides the file; needed for bare/custom model ids)"
      )
      .option(
        "--server <id-or-name...>",
        "Project HTTP server names or IDs (overrides the file)"
      ).action(async (options: CreateOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const input = loadSuiteDefinition(options);
    const resolved = resolveCloudProjectArgs(options, {
      inputProject:
        options.project === undefined && typeof input.project === "string"
          ? input.project
          : undefined,
    });
    const result = await runPlatformCommand(
      platformOptionsOf(command),
      globalOptions.timeout,
      ({ client, signal }) =>
        createEvalSuiteOperation.execute(
          { ...input, project: resolved.project },
          { client, signal }
        ),
      { projectScope: resolved.projectScope }
    );
    writeResult(result, globalOptions.format);
  });

      evals
      .command("list")
      .description("List the eval suites saved in a project")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      ).action(async (options: PlatformOptions & { project?: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runCloudOp(
      command,
      options,
      ({ client, signal }, project) =>
        listEvalSuitesOperation.execute(project, { client, signal })
    );
    writeResult(result, globalOptions.format);
  });

      evals
      .command("runs")
      .description("List a suite's run history, newest first")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
      .option(
        "--limit <n>",
        "Maximum number of runs to return (1-100)",
        (value) => Number.parseInt(value, 10)
      ).action(
    async (
      options: PlatformOptions & {
        suite: string;
        project?: string;
        limit?: number;
      },
      command
    ) => {
      const input = validateOpInput(listEvalSuiteRunsOperation, {
        suite: options.suite,
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      await executeOp(listEvalSuiteRunsOperation, input, options, command);
    }
  );

      evals
      .command("run")
      .description(
        "Start an eval run of an existing suite, or upload a versioned suite file and run it"
      )
      .option("--suite <id-or-name>", "Eval suite name or ID")
      .option(
        "--file <path>",
        "Versioned suite file to upload and run (.yaml or .json, or - for stdin)"
      )
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
      .option(
        "--server <id-or-name...>",
        "Override the suite's saved server selection (HTTP servers only)"
      )
      .option(
        "--environment <id-or-name...>",
        "Attached project environment(s) to run. Several values start one PAID RUN each."
      )
      .option(
        "--host <id-or-name...>",
        "Attached host(s) to run, so the run is stamped with that host's config. Several values start one PAID RUN each."
      )
      .option(
        "--all-targets",
        "Run EVERY attached environment (or, if none, every attached host) — one PAID RUN per target"
      )
      .option(
        "--repetitions <n>",
        "Run each case this many times under verdict policy 2 (1-10)",
        (v) => parseIntOption(v, "--repetitions")
      )
      .option("--iterations <n>", "Deprecated alias for --repetitions", (v) =>
        parseIntOption(v, "--iterations")
      )
      .option(
        "--case <id-or-title...>",
        "Run only these cases instead of the whole suite"
      )
      .option(
        "--exclude-skills",
        "Run the 'without skills' arm: no skills are pinned, and the run is labelled as excluded"
      )
      .option(
        "--refresh-snapshot",
        "PERSISTS a new host-config snapshot on the suite, changing every future run of it. Single-target runs only."
      )
      .option("--notes <text>", "Free-text note stored on the run")
      .option("--min-pass-rate <n>", "Pass threshold for this run (0-100)", (v) =>
        parseNumberOption(v, "--min-pass-rate")
      )
      .option(
        "--match-options <json>",
        'Tool-call match options for this run, e.g. \'{"toolCallOrder":"exact"}\''
      )
      .option(
        "--idempotency-key <key>",
        "Retry-safety key: repeating the call returns the run it already started"
      )
      .option("--wait", "Wait for every started run to reach a terminal status")
      .option(
        "--wait-timeout <ms>",
        "Maximum time to wait for completion (default: 600000)"
      )
      .option(
        "--reporter <json-summary|junit-xml|html>",
        "Render the completed run report to stdout"
      )
      .option(
        "--out <path>",
        "Atomically write the completed report selected by --reporter (default: json-summary)"
      )
      .option(
        "--compose-host <id-or-name>",
        "Compose a stack to run instead of naming a saved environment: the host it runs as. Default is EPHEMERAL (does not attach to the suite)."
      )
      .option(
        "--compose-computer <id-or-name>",
        "Sandbox image to pin on the composed stack"
      )
      .option(
        "--compose-model <id...>",
        "Model(s) to run on the composed stack. Replaces the client default unless --with-client-default is set."
      )
      .option(
        "--with-client-default",
        "Also launch an inherit cell that uses each client's pinned model, alongside --compose-model"
      )
      .option(
        "--save-targets",
        "Attach the composed environments to the suite (append, capped at 10). Default is ephemeral."
      )
      .option(
        "--compose-server-group <id>",
        "Standalone server group to pin on the composed stack"
      )
      .option(
        "--compose-skill <id...>",
        "Project-shared skill IDs to pin on the composed stack"
      ).action(
    async (
      options: PlatformOptions & {
        composeHost?: string;
        composeComputer?: string;
        composeModel?: string[];
        withClientDefault?: boolean;
        saveTargets?: boolean;
        composeServerGroup?: string;
        composeSkill?: string[];
        project?: string;
        suite?: string;
        file?: string;
        server?: string[];
        environment?: string[];
        host?: string[];
        allTargets?: boolean;
        repetitions?: number;
        iterations?: number;
        case?: string[];
        excludeSkills?: boolean;
        refreshSnapshot?: boolean;
        notes?: string;
        minPassRate?: number;
        matchOptions?: string;
        idempotencyKey?: string;
        wait?: boolean;
        waitTimeout?: string;
        reporter?: string;
        out?: string;
      },
      command
    ) => {
      if (options.file && options.suite) {
        throw usageError("Provide either --file or --suite, not both.");
      }
      if (!options.file && !options.suite) {
        throw usageError("Provide --suite <id-or-name> or --file <path>.");
      }
      if (
        options.repetitions !== undefined &&
        options.iterations !== undefined
      ) {
        throw usageError(
          "Use either --repetitions or its deprecated --iterations alias, not both."
        );
      }
      if (
        (options.reporter !== undefined || options.out !== undefined) &&
        !options.wait
      ) {
        throw usageError("--reporter and --out require --wait.");
      }
      if (options.waitTimeout !== undefined && !options.wait) {
        throw usageError("--wait-timeout requires --wait.");
      }
      const globalOptions = getGlobalOptions(command);
      const reporter = parseReporterFormat(options.reporter);
      const waitTimeoutMs =
        options.waitTimeout !== undefined
          ? parsePositiveInteger(options.waitTimeout, "--wait-timeout")
          : DEFAULT_RUN_WAIT_TIMEOUT_MS;
      let webOrigin = DEFAULT_PLATFORM_ORIGIN;
      const resolved = resolveCloudProjectArgs(options);
      // Auth -> 3 is scoped to THIS action, and only under --wait: the shared
      // `runPlatformOperation` preflight (below) stays the chokepoint every
      // other Cloud command relies on, including `eval gate`'s exit 3 =
      // "incomplete". Calling the same check here first makes a missing
      // credential unambiguous before the launch even starts; the internal
      // preflight then passes identically.
      if (options.wait) {
        try {
          preflightCloudCredentials(platformOptionsOf(command));
        } catch (error) {
          if (error instanceof CliError && error.exitCode === 2) throw error;
          if (error instanceof CliError) {
            throw new CliError(error.code, error.message, 3, error.details);
          }
          throw error;
        }
      }
      let result: RunEvalSuiteResult;
      try {
        result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        (context) => {
          webOrigin = context.webOrigin;
          // Fired the moment the operation resolves the disclosure for the
          // FROZEN launch plan — before it creates the run. Printing here,
          // synchronously from the callback, is what makes this actually
          // pre-run for a human watching the terminal: reading it off the
          // finished receipt afterward would print it only after the run had
          // already been created and had possibly already sent content.
          //
          // REDIRECTED TO STDERR when a reporter is configured: `--reporter`
          // writes a single structured document (junit-xml/json-summary) to
          // stdout later, and prepending human prose there would make that
          // document unparseable. But fully suppressing the block would
          // leave a CI user — the population most likely to want a record of
          // what a run discloses — with no route to it at all, despite the
          // fetch happening either way. Printing to stderr keeps stdout a
          // single parseable document while still surfacing the disclosure
          // somewhere a human or a log aggregator can see it. `--format
          // json` without a reporter is unaffected — `writeRunDisclosure`
          // already no-ops there regardless of stream.
          const onDisclosure = (disclosure: PlatformEvalRunDisclosure) => {
            writeRunDisclosure(
              globalOptions.format,
              disclosure,
              reporter === undefined ? process.stdout : process.stderr
            );
          };
          // The failure counterpart: without this, a fetch that failed and a
          // build with no disclosure feature at all look IDENTICAL to a
          // human running this command — no output either way. Same
          // reporter-stream rule as onDisclosure: stderr under a reporter,
          // stdout otherwise, never gates or delays the launch.
          const onDisclosureUnavailable = (reason: string) => {
            if (globalOptions.format !== "human") return;
            const stream = reporter === undefined ? process.stdout : process.stderr;
            stream.write(`Pre-run disclosure unavailable: ${reason}\n`);
          };
          if (options.file) {
            const source = readSuiteFileInput(options.file);
            return executeEvalRunFromFile(
              {
                client: context.client,
                signal: context.signal,
                onDisclosure,
                onDisclosureUnavailable,
              },
              {
                source,
                label: options.file === "-" ? "<stdin>" : options.file,
                projectSelector: resolved.project ?? options.project,
                knobs: {
                  ...(options.server ? { server: options.server } : {}),
                  ...(options.environment
                    ? { environment: options.environment }
                    : {}),
                  ...(options.host ? { host: options.host } : {}),
                  ...(options.allTargets ? { allTargets: true } : {}),
                  ...(options.repetitions !== undefined || options.iterations !== undefined
                    ? { repetitions: options.repetitions ?? options.iterations }
                    : {}),
                  ...(options.case?.length ? { case: options.case } : {}),
                  ...(options.excludeSkills ? { excludeSkills: true } : {}),
                  ...(options.refreshSnapshot ? { refreshSnapshot: true } : {}),
                  ...(options.notes !== undefined ? { notes: options.notes } : {}),
                  ...(options.minPassRate !== undefined
                    ? { minPassRate: options.minPassRate }
                    : {}),
                  ...(options.matchOptions
                    ? {
                        matchOptions: parseMatchOptionsOption(
                          options.matchOptions
                        ),
                      }
                    : {}),
                  ...(options.idempotencyKey
                    ? { idempotencyKey: options.idempotencyKey }
                    : {}),
                  ...composeField(options),
                },
              }
            );
          }
          return runEvalSuiteOperation.execute(
            {
              project: resolved.project ?? options.project,
              suite: options.suite!,
              ...(options.server ? { servers: options.server } : {}),
              // ONE value maps to the singular field, several to the plural:
              // the op rejects sending both, and the singular carries the
              // long-standing description a caller may already rely on.
              ...selectorField("environment", "environments", options.environment),
              ...selectorField("host", "hosts", options.host),
              ...(options.allTargets ? { allAttached: true } : {}),
              ...(options.repetitions !== undefined
                ? { repetitions: options.repetitions }
                : options.iterations !== undefined
                  ? { iterations: options.iterations }
                : {}),
              ...(options.case?.length ? { cases: options.case } : {}),
              ...(options.excludeSkills ? { excludeSkills: true } : {}),
              ...(options.refreshSnapshot ? { refreshSnapshot: true } : {}),
              ...(options.notes !== undefined ? { notes: options.notes } : {}),
              ...(options.minPassRate !== undefined
                ? { minPassRate: options.minPassRate }
                : {}),
              ...(options.matchOptions
                ? { matchOptions: parseMatchOptionsOption(options.matchOptions) }
                : {}),
              ...(options.idempotencyKey
                ? { idempotencyKey: options.idempotencyKey }
                : {}),
              ...composeField(options),
            },
            {
              client: context.client,
              signal: context.signal,
              onDisclosure,
              onDisclosureUnavailable,
            }
          );
        },
        { projectScope: resolved.projectScope }
        );
      } catch (error) {
        // Launch-phase remap, --wait only: a thrown CliError whose exitCode
        // is not already 2 (usage error / invalid suite file — untouched)
        // gets reclassified by wire code. `toCliError` drops the HTTP
        // status, so classification reads the code string, not the status.
        // `details` rides along too: a billing failure the v1 API collapsed
        // onto the wire code FORBIDDEN is only distinguishable from a real
        // credential rejection by `details.code`.
        if (options.wait && error instanceof CliError && error.exitCode !== 2) {
          throw new CliError(
            error.code,
            error.message,
            classifyLaunchErrorExitCode(error.code, error.details),
            error.details
          );
        }
        throw error;
      }
      // EXACTLY ONE JSON document on `--format json`: the receipt already
      // carries every run, so appending human lines to it would make the
      // stream unparseable for the CI callers that read it. The human-mode
      // block already printed from `onDisclosure`, ahead of the launch
      // itself — nothing to print again here.
      if (!options.wait) {
        writeResult(result, globalOptions.format);
        writeRunGroupSummary(globalOptions.format, webOrigin, result);
        // A partial or wholly failed fan-out is not a success. Exiting 0 would
        // let a pipeline treat "1 of 3 runs never started" as a clean launch.
        if (result.outcome !== "started") {
          setProcessExitCode(1);
        }
        return;
      }

      const needsReport = reporter !== undefined || options.out !== undefined;
      // Re-checked explicitly, same as the launch-phase preflight above and
      // for the same reason: `runPlatformOperation`'s own internal recheck
      // is the ONE thing that can fail from this call's outer preamble
      // (nothing inside the callback below escapes its own per-target
      // catches), and a credential that died between the launch and here
      // must read as 3 (auth), not whatever `toCliError` defaults to. The
      // launch receipt is written first — it is the only record of run ids
      // already paid for, and nothing else has reached stdout yet.
      try {
        preflightCloudCredentials(platformOptionsOf(command));
      } catch (error) {
        writeResult({ launch: result, runs: [] }, globalOptions.format);
        writeRunGroupSummary(globalOptions.format, webOrigin, result);
        if (error instanceof CliError && error.exitCode === 2) throw error;
        if (error instanceof CliError) {
          throw new CliError(error.code, error.message, 3, error.details);
        }
        throw error;
      }
      const completion = await runPlatformCommand(
        platformOptionsOf(command),
        Math.max(globalOptions.timeout, waitTimeoutMs),
        async ({ client, signal }) => {
          const deadline = Date.now() + waitTimeoutMs;
          const waited = await Promise.all(
            result.targets
              .filter((target) => target.status === "started")
              .map(async (target) => {
                try {
                  return {
                    ok: true as const,
                    run: await waitForEvalRun(
                      client,
                      signal,
                      result.project.id,
                      target.runId,
                      deadline
                    )
                  };
                } catch (error) {
                  // Capture the WIRE code before stringifying: `errorCode`,
                  // never `code` — the telemetry redactor treats any key
                  // normalizing to "code" as a possible OAuth authorization
                  // code and keeps only SCREAMING_SNAKE values (see
                  // launchFailureCases above). Only set for a real
                  // PlatformApiError; a deadline timeout (a CliError from
                  // waitForEvalRun) carries none, which is fine — the
                  // classifier's "else" bucket already means "no valid
                  // verdict observed".
                  return {
                    ok: false as const,
                    runId: target.runId,
                    error:
                      error instanceof Error ? error.message : String(error),
                    ...(isPlatformApiError(error)
                      ? { errorCode: error.code }
                      : {}),
                  };
                }
              })
          );
          const runs = waited.flatMap((entry) => (entry.ok ? [entry.run] : []));
          const waitErrors = waited.flatMap((entry) =>
            !entry.ok
              ? [
                  {
                    runId: entry.runId,
                    error: entry.error,
                    ...(entry.errorCode
                      ? { errorCode: entry.errorCode }
                      : {}),
                  },
                ]
              : []
          );

          if (!needsReport) {
            // No report was asked for, so no iteration walk was paid for — but
            // in human format the whole value of `--wait` is being told what
            // happened, and today a failing wait prints a receipt and an exit
            // code and nothing about why. One bounded read buys that back.
            //
            // SINGLE-RUN ONLY, here and below. `StructuredRunReport` carries
            // one summary and a fan-out has several runs; attaching one of them
            // would label a report about N runs with the decision of one.
            const soloSummary =
              globalOptions.format === "human" &&
              result.targets.length === 1 &&
              runs.length === 1 &&
              TERMINAL_RUN_STATUSES.has(runs[0]!.status)
                ? await readEvalRunDecisionSummary(
                    client,
                    signal,
                    result.project.id,
                    runs[0]!
                  )
                : undefined;
            // Deliberately does NOT throw on `waitErrors` here. Throwing from
            // inside the platform command skips the receipt below, and the
            // receipt is the only place the launched run ids are printed: a
            // `--wait --format json > out.json` that timed out would leave
            // `out.json` EMPTY, with the ids surviving only as prose inside a
            // stderr message. The caller cannot find, resume, or cancel the
            // runs it just paid for. The shared exit path below raises the
            // same failure after the receipt is on stdout.
            return {
              runs,
              waitErrors,
              reportInputs: [] as StructuredEvalRunInput[],
              iterationErrorCodes: new Map<string, string>(),
              ...(soloSummary ? { decisionSummary: soloSummary } : {}),
            };
          }

          // A run's own id, not `StructuredEvalRunInput` (a shared SDK type
          // report-building also consumes), is what carries a fetch
          // failure's wire code out of this loop — smuggling a new field
          // onto that type would leak an eval.ts-only concern into it.
          const iterationErrorCodes = new Map<string, string>();
          const reportInputs = await Promise.all(
            runs.map(async (run): Promise<StructuredEvalRunInput> => {
              try {
                const iterations = await fetchAllIterations(
                  client,
                  signal,
                  result.project.id,
                  run.id
                );
                return {
                  run,
                  iterations: iterations.items,
                  iterationsComplete: iterations.complete,
                };
              } catch (error) {
                if (isPlatformApiError(error)) {
                  iterationErrorCodes.set(run.id, error.code);
                }
                return {
                  run,
                  iterations: [],
                  iterationsComplete: false,
                  iterationError:
                    error instanceof Error ? error.message : String(error),
                };
              }
            })
          );
          // Free: assembled from the walk `reportInputs` already performed,
          // through the same assembler the API endpoint calls. Skipped when the
          // walk failed — a summary built from an empty iteration list would
          // report zero failures for a run nobody managed to read.
          const solo =
            result.targets.length === 1 &&
            runs.length === 1 && reportInputs.length === 1
              ? reportInputs[0]!
              : undefined;
          const decisionSummary =
            solo && solo.iterationError === undefined
              ? decisionSummaryFromIterations({
                  projectId: result.project.id,
                  run: solo.run,
                  iterations: {
                    items: [...solo.iterations],
                    complete: solo.iterationsComplete,
                  },
                })
              : undefined;
          return {
            runs,
            waitErrors,
            reportInputs,
            iterationErrorCodes,
            ...(decisionSummary ? { decisionSummary } : {}),
          };
        },
        {
          projectScope: resolved.projectScope,
          quiet: true,
        },
      );

      const report = needsReport
        ? buildEvalRunReport(completion.reportInputs, {
            cases: [
              ...launchFailureCases(result),
              ...completion.waitErrors.map((entry) => ({
                id: `${entry.runId}:wait`,
                title: `${entry.runId}: completion`,
                category: "reporting",
                passed: false,
                error: entry.error,
              })),
            ],
            metadata: {
              project: result.project,
              suite: result.suite,
              ...(result.runGroupId ? { runGroupId: result.runGroupId } : {}),
            },
            ...(completion.decisionSummary
              ? { decisionSummary: completion.decisionSummary }
              : {}),
          })
        : undefined;

      // Computed BEFORE the `--out` write: a local write failure must MERGE
      // into this verdict-derived code (worst-of), never overwrite it — a
      // run that actually failed (1) or hit a mid-wait auth failure (3)
      // outranks a plain local I/O problem (4), per the documented severity
      // order. Assigning the write failure a flat 4 here would silently
      // mask an already-known verdict failure the moment `--out` also
      // happened to be unwritable.
      const reportingErrors = completion.reportInputs.filter(
        (input) => !input.iterationsComplete || input.iterationError
      );
      const reportingFailedRunIds = new Set(
        reportingErrors.map((input) => input.run.id)
      );
      const runOutcomes: EvalRunWaitRunOutcome[] = completion.runs.map(
        (run) => ({
          status: run.status,
          result: run.result,
          reportingFailed: reportingFailedRunIds.has(run.id),
          reportingFailedErrorCode: completion.iterationErrorCodes.get(run.id),
        })
      );
      const code = evalRunWaitExitCode({
        launchOutcome: result.outcome,
        runs: runOutcomes,
        waitErrors: completion.waitErrors,
      });

      // Captured, NOT thrown here: the receipt below (or the reporter
      // stdout) carries the only copy of the launched run ids, and a local
      // disk error must not cost the caller those ids the way an early
      // throw would — same discipline the wait-error path above already
      // follows, for the same reason.
      let outWriteError: string | undefined;
      if (options.out && report) {
        try {
          await writeReporterArtifact(
            options.out,
            reporter ?? "json-summary",
            report
          );
        } catch (error) {
          outWriteError = error instanceof Error ? error.message : String(error);
        }
      }
      if (reporter && report) {
        writeReporterResult(reporter, report);
      } else {
        writeResult(
          { launch: result, runs: completion.runs },
          globalOptions.format
        );
        writeRunGroupSummary(globalOptions.format, webOrigin, result);
        // Human only, and after the receipt: the receipt carries the run ids
        // and must reach stdout first whatever else happens.
        writeEvalDecisionSummary(
          globalOptions.format,
          completion.decisionSummary,
          process.stdout
        );
      }

      // Everything above has already been written — report file, reporter
      // stdout, or the launch receipt. Only now may this fail.
      if (outWriteError !== undefined) {
        // A local `--out` write failure is infrastructure the CLI itself
        // observed, never a verdict — merged toward 4, not the
        // INTERNAL_ERROR default of 1 a bare fs error would otherwise get
        // from `normalizeCliError`, and never allowed to outrank an
        // already-computed verdict failure (1) or auth failure (3).
        throw cliError("OUT_WRITE_FAILED", outWriteError, worstOf([code, 4]));
      }
      if (reportingErrors.length > 0 || completion.waitErrors.length > 0) {
        const affectedRunIds = [
          ...reportingErrors.map((input) => input.run.id),
          ...completion.waitErrors.map((entry) => entry.runId),
        ];
        throw cliError(
          "OPERATIONAL_ERROR",
          needsReport
            ? `Completed eval run report is incomplete for: ${affectedRunIds.join(
                ", "
              )}.`
            : `Did not observe completion for: ${affectedRunIds.join(", ")}.`,
          code,
          {
            // Machine-readable, because the message is not: a pipeline that
            // needs to resume or cancel these runs should not have to parse
            // English out of stderr.
            runIds: affectedRunIds,
            ...(completion.waitErrors.length > 0
              ? { waitErrors: completion.waitErrors }
              : {}),
          }
        );
      }

      setProcessExitCode(code);
    }
  );

      addProjectOption(
      evals
      .command("status")
      .description("Get the status and summary of an eval run")
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      ).action(
    async (
      options: PlatformOptions & { project?: string; run: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      let webOrigin = DEFAULT_PLATFORM_ORIGIN;
      let decisionSummary: EvalRunDecisionSummary | undefined;
      const resolved = resolveCloudProjectArgs(options);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        async (context) => {
          webOrigin = context.webOrigin;
          const result = await getEvalRunOperation.execute(
            {
              runId: options.run,
              ...(resolved.project === undefined
                ? {}
                : { project: resolved.project }),
            } as { project: string; runId: string },
            { client: context.client, signal: context.signal }
          );
          // Any terminal run that did NOT pass — not just a failed one.
          // `inconclusive` and a run that stopped without a verdict are the
          // outcomes a reader is least able to explain on their own, and the
          // summary is the only place that says which check withheld it. A
          // clean pass is skipped: there is nothing to diagnose, and the extra
          // read would buy a block of "0 non-passing" noise.
          //
          // `getEvalRunOperation` already uses the endpoint-first, shared
          // fallback reader. Reuse that exact object instead of doing a second
          // network read (and, on old deployments, a second iteration walk).
          if (
            globalOptions.format === "human" &&
            TERMINAL_RUN_STATUSES.has(result.run.status) &&
            result.run.result !== "passed"
          ) {
            decisionSummary = result.decisionSummary;
          }
          return result;
        },
        {
          projectScope: resolved.projectScope,
          quiet: globalOptions.quiet,
        }
      );
      // The wire-shaped result is useful in JSON, but human output must not
      // leak raw decision enums (for example `argumentMismatch`) before the
      // label-aware summary below. The operation still returns the canonical
      // object verbatim for MCP/JSON consumers; this only removes the duplicate
      // machine payload from the human terminal.
      const resultForOutput =
        globalOptions.format === "human"
          ? (() => {
              const { decisionSummary: _decisionSummary, ...humanResult } = result;
              return humanResult;
            })()
          : result;
      writeResult(resultForOutput, globalOptions.format);
      writeJudgeSummary(globalOptions.format, result.run.judges);
      // Payload, then WHY, then WHERE. The `View:` line stays last on purpose:
      // it is the one thing a reader acts on after reading the rest, and a
      // block printed under it would push it out of sight on a long run.
      writeEvalDecisionSummary(
        globalOptions.format,
        decisionSummary,
        process.stdout
      );
      writeRunLink(globalOptions.format, webOrigin, {
        projectId: result.project.id,
        suiteId: result.run.suiteId,
        runId: result.run.id,
      });
    }
  );

      addProjectOption(
      evals
      .command("cancel")
      .description(
        "Cancel an in-flight eval run (no-op if already cancelled; errors if it already finished)"
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      ).action(
    async (
      options: PlatformOptions & { project?: string; run: string },
      command
    ) => {
      await executeOp(
        cancelEvalRunOperation,
        {
          runId: options.run,
          ...(options.project === undefined ? {} : { project: options.project }),
        } as { project: string; runId: string },
        options,
        command
      );
    }
  );

      addProjectOption(
      evals
      .command("judge")
      .description(
        "Grade a finished eval run with LLM as Judge (SPENDS your model budget)"
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      )
      .option("--force", "Re-grade a run that already has a judge result")
      .option(
        "--enable",
        "Grade this run even though the judge was off when it ran"
      )
      .option("--judge-model <id>", "Judge model for this run only")
      .option("--judge-threshold <0-1>", "Pass threshold for this run only").action(
    async (
      options: PlatformOptions & {
        project?: string;
        run: string;
        force?: boolean;
        enable?: boolean;
        judgeModel?: string;
        judgeThreshold?: string;
      },
      command
    ) => {
      const threshold =
        options.judgeThreshold !== undefined
          ? parseJudgeThreshold(options.judgeThreshold)
          : undefined;
      const input = validateOpInput(
        requestEvalRunJudgeOperation,
        {
          runId: options.run,
          ...(options.project === undefined ? {} : { project: options.project }),
          ...(options.force ? { force: true } : {}),
          ...(options.enable ? { enable: true } : {}),
          ...(options.judgeModel !== undefined
            ? { model: options.judgeModel }
            : {}),
          ...(threshold !== undefined ? { threshold } : {}),
        },
        { projectOptional: true }
      );
      await executeOp(
        requestEvalRunJudgeOperation,
        input,
        options,
        command
      );
    }
  );

  const PROJECT_OPT = "Project name or ID (defaults to most recently updated)";

  // ── GitHub Checks: run this suite on every pull request ────────────
  // A subgroup, not two flat commands: `checks` is a different resource from
  // the suite it points at, and flattening it would put `eval connect` next to
  // `eval run` as if they were the same kind of verb.
  const checks = evals
    .command("checks")
    .description("Run an eval suite on a repository's pull requests");

      checks
      .command("list")
      .description(
        "List the repositories running an eval suite on their pull requests"
      )
      .option("--project <id-or-name>", PROJECT_OPT).action(async (options: PlatformOptions & { project?: string }, command) => {
    await executeOp(
      listEvalCheckReposOperation,
      { project: options.project },
      options,
      command
    );
  });

      checks
      .command("connect")
      .description(
        "Run this suite on every pull request to a repository (affects everyone who opens one)"
      )
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .requiredOption("--repo <owner/repo>", "Repository to connect")
      .requiredOption(
        "--outage-policy <fail-open|fail-closed>",
        "What the check reports when MCPJam cannot conclude"
      )
      .option("--project <id-or-name>", PROJECT_OPT).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        repo: string;
        outagePolicy: string;
      },
      command
    ) => {
      // A Map, not an object literal: `{...}[key]` consults the prototype
      // chain, so `--outage-policy constructor` would be truthy, skip the
      // message written for the caller, and fail later against a schema they
      // never typed.
      const policy = OUTAGE_POLICY_BY_FLAG.get(options.outagePolicy);
      if (!policy) {
        throw usageError(
          '--outage-policy must be "fail-open" or "fail-closed". fail-closed blocks merges while MCPJam cannot conclude; fail-open lets an unverified change through.'
        );
      }
      const input = validateOpInput(connectEvalCheckRepoOperation, {
        project: options.project,
        suite: options.suite,
        repo: options.repo,
        outagePolicy: policy,
      });
      await executeOp(connectEvalCheckRepoOperation, input, options, command);
    }
  );

  // ── Eval run iterations + traces ───────────────────────────────────
      addProjectOption(
      evals
      .command("iterations")
      .description(
        "List per-iteration results for an eval run (pass/fail, tool calls, tokens, latency)"
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      )
      .option("--cursor <cursor>", "Pagination cursor from a previous response")
      .option("--limit <n>", "Max iterations per page (1–200)").action(
    async (
      options: PlatformOptions & {
        project?: string;
        run: string;
        cursor?: string;
        limit?: string;
      },
      command
    ) => {
      const input = validateOpInput(
        listEvalRunIterationsOperation,
        {
          runId: options.run,
          ...(options.project === undefined ? {} : { project: options.project }),
          ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
          ...(options.limit !== undefined
            ? { limit: Number(options.limit) }
            : {}),
        },
        { projectOptional: true }
      );
      await executeOp(
        listEvalRunIterationsOperation,
        input,
        options,
        command
      );
    }
  );

      const gateCommand = addProjectOption(
      evals
      .command("gate")
      .description(
        "Apply a pass/fail policy to a finished eval run and set an exit code (0 pass or waived, 1 eval failure, 2 usage, 3 incomplete)"
      )
      // `.option`, not `.requiredOption`, ONLY so that `gate waive` and `gate
      // unwaive` below can exist: commander enforces a parent's mandatory
      // options before dispatching to a subcommand, so a required `--run`
      // here would make every `gate waive` invocation fail on the parent's
      // check. Absence is enforced in `runEvalGate` instead.
      //
      // The exit code is UNCHANGED by that move: commander's own
      // missing-option error is mapped to 2 (USAGE_ERROR) by the CLI
      // entrypoint, which is exactly what `usageError` produces.
      .option("--run <id>", "Eval run ID (from `eval run`)")
      )
      .option(
        "--min-pass-rate-percent <0-100>",
        "Minimum share of iterations that must pass, as a percentage"
      )
      .option(
        "--no-gating-score-errors",
        "Fail if any gating scorer errored during the run"
      )
      .option(
        "--min-scorer-pass-rate <scorerId=percent>",
        "Minimum pass rate for one scorer (repeatable)",
        collectRepeatable,
        [] as string[]
      )
      .option(
        "--min-mean-score <scorerId=0..1>",
        "Minimum mean score for one scorer (repeatable)",
        collectRepeatable,
        [] as string[]
      )
      .option(
        "--baseline <runId>",
        "Baseline run ID to gate a regression delta against; mutually exclusive with --baseline-sha"
      )
      .option(
        "--baseline-sha <sha>",
        "Baseline source commit SHA, resolved to the completed run in this suite recorded against it; mutually exclusive with --baseline"
      )
      .option(
        "--min-sample-size <n>",
        "Iterations required on EACH side before a pass-rate regression is decidable (default 5); requires --baseline or --baseline-sha"
      )
      .option(
        "--min-effect-size-percent <0-100>",
        "Smallest pass-rate drop worth failing on, as a percentage (default 1); requires --baseline or --baseline-sha"
      )
      .option(
        "--gate-deterministic-regressions",
        "Fail if a deterministic gating scorer flipped from passed to failed; requires --baseline or --baseline-sha"
      )
      .option(
        "--max-p95-latency-increase-ms <ms>",
        "Fail if p95 end-to-end latency rose by more than this many milliseconds vs the baseline; requires --baseline or --baseline-sha"
      )
      .option("--wait", "Poll until the run reaches a terminal status")
      .option(
        "--wait-timeout <ms>",
        "Give up waiting after this many milliseconds (default 600000)"
      )
      .option(
        "--reporter <json-summary|junit-xml|html>",
        "Write a structured report to stdout instead of the default output"
      )
      .option(
        "--out <path>",
        "Atomically write the structured report selected by --reporter (default: json-summary)"
      ).action(
    async (
      options: PlatformOptions &
        EvalGateOptions & {
          project?: string;
          run?: string;
          wait?: boolean;
          waitTimeout?: string;
          reporter?: string;
          out?: string;
        },
      command
    ) => {
      await runEvalGate(options, command);
    }
  );

  // ── `eval gate waive` / `eval gate unwaive` ───────────────────────────────
  //
  // Subcommands of `gate`, sharing its `--run` and `--project`. Commander
  // gives a parent's declared options to the parent even when a subcommand
  // runs, so these read them off `gate` rather than redeclaring them — a
  // second `--run` on the subcommand is consumed by the parent and the
  // subcommand's own mandatory check then fails on a flag the user did pass.
  //
  // NEITHER COMMAND PRE-JUDGES AUTHORIZATION. Waiving is manage-tier and the
  // platform enforces it; a local guess would either block someone entitled to
  // waive or let an unauthorized attempt look accepted until the write failed.
  gateCommand
    .command("waive")
    .description(
      "Override a FAILING run's gate until an expiry you name. Does not make the run pass: the run keeps its result, and the waiver is named in every report and check."
    )
    .requiredOption(
      "--reason <text>",
      `Why the gate is being overridden (max ${GATE_WAIVER_MAX_REASON_LENGTH} characters). ${GATE_WAIVER_REASON_NOTICE}`
    )
    .requiredOption(
      "--expires-in <duration>",
      "How long the waiver lasts, e.g. 30m, 12h, 7d. Capped at 30 days by the platform — there is no permanent waiver."
    )
    .action(async (options: { reason: string; expiresIn: string }, command) => {
      await runEvalGateWaive(options, command);
    });

  gateCommand
    .command("unwaive")
    .description(
      "Revoke a gate waiver, putting the gate and the GitHub Check Run back. Idempotent."
    )
    .option(
      "--waiver <id>",
      "Waiver ID to revoke. Omit to revoke the waiver currently in force over --run."
    )
    .action(async (options: { waiver?: string }, command) => {
      await runEvalGateUnwaive(options, command);
    });

      addProjectOption(
      evals
      .command("compare")
      .description(
        "Compare a finished eval run against a baseline and set an exit code (0 pass, 1 regression, 2 usage, 3 incomplete)"
      )
      .requiredOption("--run <id>", "Eval run ID to compare")
      )
      .option(
        "--base-run <id>",
        "Baseline run ID (defaults to the nearest earlier completed run in the same suite); mutually exclusive with --base-sha"
      )
      .option(
        "--base-sha <sha>",
        "Baseline source commit SHA, resolved to the completed run in this suite recorded against it; mutually exclusive with --base-run"
      )
      .option(
        "--gate-regressions",
        "Fail on a statistically significant pass-rate regression"
      )
      .option(
        "--min-sample-size <n>",
        "Iterations required on EACH side before a pass-rate regression is decidable (default 5)"
      )
      .option(
        "--min-effect-size-percent <0-100>",
        "Smallest pass-rate drop worth failing on, as a percentage (default 1)"
      )
      .option(
        "--gate-deterministic-regressions",
        "Fail if a deterministic gating scorer flipped from passed to failed"
      )
      .option(
        "--max-p95-latency-increase-ms <ms>",
        "Fail if p95 end-to-end latency rose by more than this many milliseconds"
      )
      .option(
        "--reporter <json-summary|junit-xml|html>",
        "Write a structured report to stdout instead of the default output"
      )
      .option(
        "--out <path>",
        "Atomically write the structured report selected by --reporter (default: json-summary)"
      ).action(
    async (
      options: PlatformOptions &
        EvalCompareOptions & {
          project?: string;
          run: string;
          baseRun?: string;
          baseSha?: string;
          reporter?: string;
          out?: string;
        },
      command
    ) => {
      await runEvalCompare(options, command);
    }
  );

  evals
    .command("validate")
    .description(
      "Validate a local eval suite file offline — no auth, no network unless --project is passed (0 valid, 1 contract-invalid or unresolved reference, 2 unreadable/oversize/malformed)"
    )
    .requiredOption(
      "--file <path>",
      "Suite file to validate, .yaml or .json (or - for stdin)"
    )
    .option(
      "--project <id-or-name>",
      "Also resolve the file's deterministic tool references against this project's live servers. Opt-in: without it the command stays entirely offline."
    )
    .action(
      async (
        options: PlatformOptions & { file: string; project?: string },
        command: Command
      ) => {
        await runEvalValidate(options, command);
      }
    );

      evals
      .command("export")
      .description(
        "Write a hosted eval suite to a local suite file, refusing anything it cannot represent losslessly"
      )
      .requiredOption(
        "--suite <id-or-name>",
        "Eval suite to export (name or ID)"
      )
      .option(
        "--project <id-or-name>",
        "Project the suite belongs to (defaults to the most recently updated project)"
      )
      .option(
        "--out <path>",
        "Where to write (default .mcpjam/evals/<suite-id>.yaml)"
      )
      .option("--force", "Replace an existing file at the output path").action(
    async (
      options: PlatformOptions & {
        suite: string;
        project?: string;
        out?: string;
        force?: boolean;
      },
      command
    ) => {
      await runEvalExport(options, command);
    }
  );

      evals
      .command("pull")
      .description(
        "LEGACY: materialize a hosted eval suite into a corpus lock for @mcpjam/vitest — new work should use `eval export` (0 clean, 1 drift under --frozen, 2 usage, 3 incomplete)"
      )
      .requiredOption("--suite <id-or-name>", "Eval suite to pull (name or ID)")
      .option(
        "--project <id-or-name>",
        "Project the suite belongs to (defaults to the most recently updated project)"
      )
      .option(
        "--lock <path>",
        `Lock file path (default ${DEFAULT_CORPUS_LOCK_PATH})`
      )
      .option(
        "--frozen",
        "Verify the lock matches the hosted suite without writing; exit 1 on drift"
      )
      .option(
        "--skip-unsupported",
        "Omit cases a local run cannot execute instead of failing"
      ).action(
    async (
      options: PlatformOptions & {
        suite: string;
        project?: string;
        lock?: string;
        frozen?: boolean;
        skipUnsupported?: boolean;
      },
      command
    ) => {
      await runEvalPull(options, command);
    }
  );

      addProjectOption(
      evals
      .command("trace")
      .description(
        "Fetch the full trace for one eval iteration (large: full message history + spans)"
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption(
        "--iteration <id>",
        "Iteration ID (from `eval iterations`)"
      )
      ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        run: string;
        iteration: string;
      },
      command
    ) => {
      await executeOp(
        getEvalIterationTraceOperation,
        {
          runId: options.run,
          iterationId: options.iteration,
          ...(options.project === undefined ? {} : { project: options.project }),
        } as Parameters<typeof getEvalIterationTraceOperation.execute>[0],
        options,
        command
      );
    }
  );

      addProjectOption(
      evals
      .command("steps")
      .description(
        "Per-authored-step results for one eval iteration: status (ok/fail/skipped/pending), reason, and evidence (screenshot/video URLs). The fastest way to see WHICH step failed and why."
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption(
        "--iteration <id>",
        "Iteration ID (from `eval iterations`)"
      )
      ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        run: string;
        iteration: string;
      },
      command
    ) => {
      await executeOp(
        getEvalRunStepsOperation,
        {
          runId: options.run,
          iterationId: options.iteration,
          ...(options.project === undefined ? {} : { project: options.project }),
        } as Parameters<typeof getEvalRunStepsOperation.execute>[0],
        options,
        command
      );
    }
  );

      addProjectOption(
      evals
      .command("screenshot")
      .description(
        "Show the widget screenshot(s) an eval iteration rendered — inline when the terminal supports it, otherwise the image URL"
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption(
        "--iteration <id>",
        "Iteration ID (from `eval iterations`)"
      )
      )
      .option(
        "--out <path>",
        "Save the PNG(s) to a file or directory instead of rendering inline"
      )
      .option("--index <n>", "Show only the Nth screenshot (1-based)").action(
    async (
      options: PlatformOptions & {
        project?: string;
        run: string;
        iteration: string;
        out?: string;
        index?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const index =
        options.index !== undefined
          ? parsePositiveInteger(options.index, "--index")
          : undefined;

      const resolved = resolveCloudProjectArgs(options);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          getEvalIterationTraceOperation.execute(
            {
              runId: options.run,
              iterationId: options.iteration,
              ...(resolved.project === undefined
                ? {}
                : { project: resolved.project }),
            } as Parameters<typeof getEvalIterationTraceOperation.execute>[0],
            { client, signal }
          ),
        {
          projectScope: resolved.projectScope,
          quiet: globalOptions.quiet,
        }
      );

      let shots = extractRenderedScreenshots(result);
      if (index !== undefined) {
        if (index > shots.length) {
          throw usageError(
            `--index ${index} is out of range; this iteration rendered ${shots.length} screenshot(s).`
          );
        }
        shots = [shots[index - 1]];
      }

      const base = {
        project: result.project,
        runId: result.runId,
        iterationId: result.iterationId,
      };
      const isJson = globalOptions.format === "json";

      // Save mode: download each PNG to disk regardless of output format.
      if (options.out !== undefined) {
        const saved: ScreenshotItem[] = [];
        for (let i = 0; i < shots.length; i += 1) {
          const shot = shots[i];
          const bytes = await fetchScreenshotBytes(
            shot.screenshotUrl,
            globalOptions.timeout
          );
          const path = resolveScreenshotPath(
            options.out,
            shot,
            i,
            shots.length
          );
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, bytes);
          saved.push({ ...shot, savedTo: path });
        }
        if (isJson) {
          writeResult({ ...base, items: saved });
          return;
        }
        if (saved.length === 0) {
          process.stdout.write(
            "No rendered widget screenshots for this iteration.\n"
          );
          return;
        }
        for (const shot of saved) {
          process.stdout.write(
            `Saved ${shot.toolName ?? "widget"} → ${shot.savedTo}\n`
          );
        }
        return;
      }

      // JSON without --out: structured screenshot URLs, no image bytes.
      if (isJson) {
        writeResult({ ...base, items: shots });
        return;
      }

      // Human: render inline if the terminal supports it, else print the URL.
      if (shots.length === 0) {
        process.stdout.write(
          "No rendered widget screenshots for this iteration.\n"
        );
        return;
      }
      const protocol = detectInlineImageProtocol();
      for (const shot of shots) {
        const caption = `${shot.toolName ?? "widget"} · ${shot.status}`;
        if (protocol) {
          const bytes = await fetchScreenshotBytes(
            shot.screenshotUrl,
            globalOptions.timeout
          );
          process.stdout.write(`${caption}\n`);
          process.stdout.write(encodeInlineImage(bytes, protocol));
        } else {
          process.stdout.write(`${caption}  ${shot.screenshotUrl}\n`);
        }
      }
    }
  );

      addProjectOption(
      evals
      .command("video")
      .description(
        "Get the Playwright replay video (.webm) an eval iteration recorded — prints the URL, or downloads it with --out"
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption(
        "--iteration <id>",
        "Iteration ID (from `eval iterations`)"
      )
      )
      .option(
        "--out <path>",
        "Download the .webm to this file instead of printing the URL"
      ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        run: string;
        iteration: string;
        out?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const resolved = resolveCloudProjectArgs(options);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          getEvalIterationTraceOperation.execute(
            {
              runId: options.run,
              iterationId: options.iteration,
              ...(resolved.project === undefined
                ? {}
                : { project: resolved.project }),
            } as Parameters<typeof getEvalIterationTraceOperation.execute>[0],
            { client, signal }
          ),
        {
          projectScope: resolved.projectScope,
          quiet: globalOptions.quiet,
        }
      );

      const videoUrl = extractIterationVideoUrl(result);
      const base = {
        project: result.project,
        runId: result.runId,
        iterationId: result.iterationId,
      };
      const isJson = globalOptions.format === "json";

      if (!videoUrl) {
        if (isJson) {
          writeResult({ ...base, videoUrl: null });
          return;
        }
        process.stdout.write("No replay video for this iteration.\n");
        return;
      }

      if (options.out !== undefined) {
        const bytes = await fetchArtifactBytes(
          videoUrl,
          globalOptions.timeout,
          "video"
        );
        mkdirSync(dirname(options.out), { recursive: true });
        writeFileSync(options.out, bytes);
        if (isJson) {
          writeResult({ ...base, videoUrl, savedTo: options.out });
          return;
        }
        process.stdout.write(`Saved replay video → ${options.out}\n`);
        return;
      }

      if (isJson) {
        writeResult({ ...base, videoUrl });
        return;
      }
      process.stdout.write(`${videoUrl}\n`);
    }
  );

  // ── Suite settings: get / update / delete / schedule ───────────────
      evals
      .command("get")
      .description("Show an eval suite's full settings")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT).action(
    async (
      options: PlatformOptions & { project?: string; suite: string },
      command
    ) => {
      await executeOp(
        getEvalSuiteOperation,
        { project: options.project, suite: options.suite },
        options,
        command
      );
    }
  );

      evals
      .command("update")
      .description(
        "Edit an eval suite's settings (only the flags you pass change)"
      )
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option("--file <path>", "Suite-update JSON body (or - for stdin)")
      .option("--json <json>", "Inline suite-update JSON (or @file, or -)")
      .option("--name <name>", "Rename the suite")
      .option("--description <text>", "Suite description")
      .option(
        "--server <id-or-name...>",
        "Replace the suite's server selection (project server names or IDs)"
      )
      .option(
        "--computer-image <id-or-name|off>",
        "Sandbox image eval runs boot from (see `mcpjam cloud images list`); off uses the default base image"
      )
      .option("--host <id-or-name...>", "Replace host attachments (by name or ID)")
      .option("--model <id>", "Execution model id")
      .option("--system-prompt <text>", "Execution system prompt")
      .option("--temperature <n>", "Execution temperature")
      .option("--min-accuracy <pct>", "Minimum accuracy, 0–100")
      .option(
        "--min-iterations <1-10|off>",
        "Floor on per-case iterations; off removes the floor"
      )
      .option("--tool-call-order <any|in-order|exact>", "Tool call order")
      .option("--arguments <ignore|partial|exact>", "Argument matching")
      .option("--extra-tool-calls <unlimited|N>", "Allowed extra tool calls")
      .option(
        "--judge <on|off>",
        "Turn LLM-as-judge grading on/off (grades every run as it completes)"
      )
      .option("--judge-model <id>", "Judge model id")
      .option("--judge-threshold <0-1>", "Judge pass threshold, 0–1").action(async (options: PlatformOptions & Record<string, any>, command) => {
    const input = validateOpInput(
      updateEvalSuiteOperation,
      buildSuiteUpdateInput(options)
    );
    await executeOp(updateEvalSuiteOperation, input, options, command);
  });

      evals
      .command("delete")
      .description("Permanently delete an eval suite (and its cases and runs)")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT).action(
    async (
      options: PlatformOptions & { project?: string; suite: string },
      command
    ) => {
      await executeOp(
        deleteEvalSuiteOperation,
        { project: options.project, suite: options.suite },
        options,
        command
      );
    }
  );

      evals
      .command("schedule")
      .description("Enable or disable scheduled runs for a suite")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option("--enable", "Enable scheduled runs")
      .option("--disable", "Disable scheduled runs")
      .option("--interval <minutes>", "Run interval in minutes (5–10080)")
      .option(
        "--environment <id-or-name>",
        "Project environment the scheduled runs launch (only with --enable)"
      ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        enable?: boolean;
        disable?: boolean;
        interval?: string;
        environment?: string;
      },
      command
    ) => {
      if (options.enable && options.disable) {
        throw usageError("Pass either --enable or --disable, not both.");
      }
      if (!options.enable && !options.disable) {
        throw usageError("Pass --enable or --disable.");
      }
      const input = validateOpInput(setEvalSuiteScheduleOperation, {
        project: options.project,
        suite: options.suite,
        enabled: Boolean(options.enable),
        ...(options.interval !== undefined
          ? { intervalMinutes: Number(options.interval) }
          : {}),
        ...(options.environment ? { environment: options.environment } : {}),
      });
      await executeOp(setEvalSuiteScheduleOperation, input, options, command);
    }
  );

  // ── Suite environment attachments ──────────────────────────────────
  const environments = evals
    .command("environments")
    .description(
      "Attach or detach the project environments an eval suite runs against"
    );

      environments
      .command("set")
      .description(
        "Replace the suite's attached environments (this sets the whole list)"
      )
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .requiredOption(
        "--environment <id-or-name...>",
        "Project environments to attach, in order"
      )
      .option("--project <id-or-name>", PROJECT_OPT).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        environment: string[];
      },
      command
    ) => {
      await executeOp(
        setEvalSuiteEnvironmentsOperation,
        {
          project: options.project,
          suite: options.suite,
          environments: options.environment,
        },
        options,
        command
      );
    }
  );

      environments
      .command("clear")
      .description(
        "Detach every environment, reverting the suite to its saved server selection"
      )
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT).action(
    async (
      options: PlatformOptions & { project?: string; suite: string },
      command
    ) => {
      await executeOp(
        setEvalSuiteEnvironmentsOperation,
        {
          project: options.project,
          suite: options.suite,
          environments: null,
        },
        options,
        command
      );
    }
  );

  // ── Case CRUD + generate ───────────────────────────────────────────
  const cases = evals
    .command("cases")
    .description("List, author, and edit an eval suite's test cases");

      cases
      .command("list")
      .description("List a suite's test cases")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT).action(
    async (
      options: PlatformOptions & { project?: string; suite: string },
      command
    ) => {
      await executeOp(
        listEvalCasesOperation,
        { project: options.project, suite: options.suite },
        options,
        command
      );
    }
  );

      cases
      .command("get")
      .description("Show one test case")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .requiredOption("--case <id-or-title>", "Eval case title or ID")
      .option("--project <id-or-name>", PROJECT_OPT).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        case: string;
      },
      command
    ) => {
      await executeOp(
        getEvalCaseOperation,
        { project: options.project, suite: options.suite, case: options.case },
        options,
        command
      );
    }
  );

      cases
      .command("run")
      .description(
        "Run a single case as a persisted, fully-queryable run (inspect it with `eval iterations` / `eval steps` like any run)"
      )
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .requiredOption("--case <id-or-title>", "Eval case title or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option(
        "--server <id-or-name...>",
        "Override the suite's saved servers for this run"
      )
      .option(
        "--environment <id-or-name>",
        "Project environment to run against (must be attached to the suite)"
      )
      .option(
        "--host <id-or-name>",
        "Attached host to run against, so the run is stamped with that host's config"
      )
      .option(
        "--repetitions <n>",
        "Run the case this many times under verdict policy 2 (1-10)",
        (v) => parseIntOption(v, "--repetitions")
      )
      .option("--iterations <n>", "Deprecated alias for --repetitions", (v) =>
        parseIntOption(v, "--iterations")
      )
      .option(
        "--idempotency-key <key>",
        "Retry-safety key: repeating the call returns the run it already started"
      )
      .option(
        "--compose-host <id-or-name>",
        "Compose a stack to run this case instead of naming a saved environment. Default is EPHEMERAL."
      )
      .option(
        "--compose-computer <id-or-name>",
        "Sandbox image to pin on the composed stack"
      )
      .option(
        "--compose-model <id>",
        "One model to run this case on. A matrix of models is suite-level (`eval run`) only."
      )
      .option(
        "--compose-server-group <id>",
        "Standalone server group to pin on the composed stack"
      )
      .option(
        "--compose-skill <id...>",
        "Project-shared skill IDs to pin on the composed stack"
      ).action(
    async (
      options: PlatformOptions & {
        composeHost?: string;
        composeComputer?: string;
        composeModel?: string;
        composeServerGroup?: string;
        composeSkill?: string[];
        project?: string;
        suite: string;
        case: string;
        server?: string[];
        environment?: string;
        host?: string;
        repetitions?: number;
        iterations?: number;
        idempotencyKey?: string;
      },
      command
    ) => {
      if (
        options.repetitions !== undefined &&
        options.iterations !== undefined
      ) {
        throw usageError(
          "Use either --repetitions or its deprecated --iterations alias, not both."
        );
      }
      await executeOp(
        runEvalCaseOperation,
        {
          project: options.project,
          suite: options.suite,
          case: options.case,
          ...(options.server?.length ? { servers: options.server } : {}),
          ...(options.environment ? { environment: options.environment } : {}),
          ...(options.host ? { host: options.host } : {}),
          ...(options.repetitions !== undefined
            ? { repetitions: options.repetitions }
            : options.iterations !== undefined
              ? { iterations: options.iterations }
            : {}),
          ...(options.idempotencyKey
            ? { idempotencyKey: options.idempotencyKey }
            : {}),
          ...composeField(options),
        },
        options,
        command
      );
    }
  );

      cases
      .command("create")
      .description("Add a test case to a suite (definition via --file/--json)")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option("--file <path>", "Case JSON body (or - for stdin)")
      .option("--json <json>", "Inline case JSON (or @file, or -)")
      .option("--title <title>", "Case title (overrides the body)").action(async (options: PlatformOptions & Record<string, any>, command) => {
    const input = validateOpInput(
      createEvalCaseOperation,
      buildCaseInput(options, { requireCase: false })
    );
    await executeOp(createEvalCaseOperation, input, options, command);
  });

      cases
      .command("update")
      .description("Edit a test case (definition via --file/--json)")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .requiredOption("--case <id-or-title>", "Eval case title or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option("--file <path>", "Case JSON body (or - for stdin)")
      .option("--json <json>", "Inline case JSON (or @file, or -)")
      .option("--title <title>", "Rename the case").action(async (options: PlatformOptions & Record<string, any>, command) => {
    const input = validateOpInput(
      updateEvalCaseOperation,
      buildCaseInput(options, { requireCase: true })
    );
    await executeOp(updateEvalCaseOperation, input, options, command);
  });

      cases
      .command("delete")
      .description("Permanently delete a test case")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .requiredOption("--case <id-or-title>", "Eval case title or ID")
      .option("--project <id-or-name>", PROJECT_OPT).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        case: string;
      },
      command
    ) => {
      await executeOp(
        deleteEvalCaseOperation,
        { project: options.project, suite: options.suite, case: options.case },
        options,
        command
      );
    }
  );

      cases
      .command("generate")
      .description(
        "AI-generate test cases from the suite's tools (spends credits)"
      )
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option("--mode <normal|negative>", "Generation mode (default normal)")
      .option(
        "--server <id-or-name...>",
        "Servers to discover tools from (default: suite's)"
      )
      .option(
        "--environment <id-or-name>",
        "Discover tools from this attached environment's server set"
      )
      .option(
        "--case-model <id...>",
        "Execution model(s) for the generated cases"
      )
      .option("--simple <n>", "How many easy, single-tool cases")
      .option("--multi-tool <n>", "How many medium, 2+ tool cases")
      .option("--multi-turn <n>", "How many multi-turn follow-up cases")
      .option("--complex <n>", "How many hard / cross-server cases")
      .option("--negative <n>", "How many negative (no-tool) cases")
      .option(
        "--vary-user-styles",
        "Vary query phrasing across a realistic range of user styles"
      )
      .option(
        "--idempotency-key <key>",
        "Retry-safety key: repeating the call replays the first attempt's drafts instead of generating (and billing) again"
      ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        mode?: string;
        server?: string[];
        environment?: string;
        caseModel?: string[];
        simple?: string;
        multiTool?: string;
        multiTurn?: string;
        complex?: string;
        negative?: string;
        varyUserStyles?: boolean;
        idempotencyKey?: string;
      },
      command
    ) => {
      const caseMix: Record<string, number> = {};
      for (const key of [
        "simple",
        "multiTool",
        "multiTurn",
        "complex",
        "negative",
      ] as const) {
        const raw = options[key];
        if (raw !== undefined) {
          // Number() (not parseInt) so partial junk like "2abc" is rejected
          // rather than silently truncated to 2.
          const parsed = Number(raw);
          if (!Number.isInteger(parsed)) {
            const flag = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
            throw usageError(
              `--${flag} requires an integer value, got "${raw}".`
            );
          }
          caseMix[key] = parsed;
        }
      }
      const input = validateOpInput(generateEvalCasesOperation, {
        project: options.project,
        suite: options.suite,
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.server ? { servers: options.server } : {}),
        ...(options.environment ? { environment: options.environment } : {}),
        ...(options.caseModel
          ? { caseModels: options.caseModel.map((model) => ({ model })) }
          : {}),
        ...(Object.keys(caseMix).length > 0 ? { caseMix } : {}),
        ...(options.varyUserStyles ? { varyUserStyles: true } : {}),
        ...(options.idempotencyKey
          ? { idempotencyKey: options.idempotencyKey }
          : {}),
      });
      await executeOp(generateEvalCasesOperation, input, options, command);
    }
  );
}
