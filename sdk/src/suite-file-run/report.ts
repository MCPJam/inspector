/**
 * The local run's structured report: `kind: "eval-local-run"`, with a
 * VALIDATED metadata contract, and the one formatter every terminal shares.
 *
 * Pure and browser-safe: no `node:` imports, no process, no I/O. It is built
 * by `runSuiteFile`, rendered by the common structured-report renderers (JSON,
 * JUnit, HTML — which narrow on {@link isLocalEvalRunReport} rather than
 * casting arbitrary metadata), and printed by the CLI's human output through
 * {@link formatLocalEvalRunSummary}.
 *
 * ── What the report may claim ───────────────────────────────────────────────
 *
 * Execution is local and EMULATED: an emulated host template is a handshake
 * and settings profile, never the named client itself. The verdict authority
 * is the local mirror of the v2 policy (`local-policy-v2`), with no hosted run
 * id and no hosted decision summary. An interrupted run's decision is shown
 * as partial evidence, never as a completed gate. Upload is always off.
 *
 * Nothing secret is representable here: servers are a name, a non-secret
 * source label and a transport kind — no URL, header, command line or env.
 */

import { z } from "zod";
import {
  EVAL_VERDICT_DECISION_REASON_LABELS,
  TOOL_POLICY_DECISION_REASONS,
  evalVerdictDecisionSchema,
  type EvalVerdictDecision,
} from "../contract/index.js";
import type {
  StructuredCaseResult,
  StructuredRunReport,
  StructuredRunSummary,
} from "../structured-reporting.js";
import type {
  SuiteFileCaseRun,
  SuiteFileRunIssue,
  SuiteFileRunTermination,
  SuiteFileRunVerdict,
  SuiteFileToolPolicyBlock,
} from "./types.js";

export const LOCAL_EVAL_RUN_REPORT_KIND = "eval-local-run" as const;
export const LOCAL_VERDICT_AUTHORITY = "local-policy-v2" as const;

// ── the metadata contract ────────────────────────────────────────────────────

const issueSchema = z
  .object({
    code: z.string(),
    phase: z.enum(["validation", "setup", "execution", "reporting"]),
    category: z.string(),
    message: z.string(),
    caseId: z.string().optional(),
    iterationNumber: z.number().int().optional(),
  })
  .strict();

const policyBlockSchema = z
  .object({
    caseId: z.string(),
    iterationNumber: z.number().int(),
    toolName: z.string(),
    toolCallId: z.string().optional(),
    reason: z.enum(TOOL_POLICY_DECISION_REASONS),
    classification: z.enum(["readOnly", "destructive", "unknown"]),
  })
  .strict();

const iterationSchema = z
  .object({
    iterationNumber: z.number().int().min(1),
    status: z.enum([
      "pending",
      "running",
      "completed",
      "failed",
      "cancelled",
      "timed_out",
      "setup_failed",
      "skipped",
    ]),
    taskVerdict: z.enum(["passed", "failed"]).optional(),
    evaluatorError: z.boolean().optional(),
    error: z.string().optional(),
    refusal: z
      .enum(["credentials", "billing", "rateLimited", "unavailable"])
      .optional(),
    toolCalls: z.array(
      z
        .object({
          toolName: z.string(),
          arguments: z.record(z.string(), z.unknown()),
          rawArguments: z.string().optional(),
        })
        .strict()
    ),
    policyBlocks: z.array(policyBlockSchema),
    scores: z.array(
      z
        .object({
          scorerId: z.string(),
          role: z.string().optional(),
          status: z.string(),
          passed: z.boolean().optional(),
          reason: z.string().optional(),
        })
        .strict()
    ),
    stage: z.record(z.string(), z.unknown()).optional(),
    durationMs: z.number().min(0),
    tokens: z
      .object({ input: z.number(), output: z.number(), total: z.number() })
      .strict(),
  })
  .strict();

const judgeSchema = z
  .object({
    configured: z.boolean(),
    effective: z
      .object({
        enabled: z.boolean(),
        autoRun: z.boolean(),
        role: z.enum(["advisory", "gating", "required"]),
        threshold: z.number().optional(),
        model: z.string().optional(),
      })
      .strict(),
    run: z.literal(false),
    skipReason: z.enum(["disabled", "notAutomatic", "localJudgeUnsupported"]),
  })
  .strict();

const caseSchema = z
  .object({
    caseId: z.string(),
    title: z.string(),
    intent: z.string().optional(),
    kind: z.enum(["capability", "regression"]).optional(),
    isNegativeTest: z.boolean(),
    declaredModel: z.string(),
    declaredProvider: z.string().optional(),
    effectiveModel: z.string(),
    rail: z.enum(["byok", "mcpjam"]),
    provider: z.string(),
    configuredIterations: z.number().int().min(1),
    passThreshold: z.number().min(0).max(1),
    evaluationConfigHash: z.string(),
    scorerIds: z.array(z.string()),
    judge: judgeSchema,
    import: z
      .object({
        status: z.enum(["exact", "approximated"]),
        sourceCaseKey: z.string().optional(),
        approval: z
          .object({
            reason: z.string(),
            approvedAt: z.string(),
            actor: z.literal("local-invocation"),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    state: z.enum(["completed", "interrupted", "notStarted"]),
    verdict: z.enum(["passed", "failed", "inconclusive", "notRun"]),
    iterations: z.array(iterationSchema),
  })
  .strict();

export const localEvalRunMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    execution: z
      .object({
        mode: z.literal("local"),
        engine: z.literal("emulated"),
        host: z
          .object({
            templateId: z.string().nullable(),
            clientInfo: z
              .object({ name: z.string(), version: z.string().optional() })
              .strict()
              .optional(),
            supportedProtocolVersions: z.array(z.string()).optional(),
          })
          .strict(),
        sdkVersion: z.string(),
        evaluatorVersion: z.string(),
        declaredHosts: z.array(
          z
            .object({
              name: z.string(),
              id: z.string().optional(),
              servers: z.array(z.string()).optional(),
              executed: z.literal(false),
            })
            .strict()
        ),
        declaredEnvironment: z
          .object({ name: z.string(), resolved: z.literal(false) })
          .strict()
          .nullable(),
        servers: z.array(
          z
            .object({
              name: z.string(),
              source: z.string().nullable(),
              transport: z.enum(["stdio", "http"]),
            })
            .strict()
        ),
        settings: z
          .object({
            concurrency: z.number().int().min(1),
            iterationTimeoutMs: z.number().int().min(1),
            maxSteps: z.number().int().min(1),
            setupTimeoutMs: z.number().int().min(1),
            systemPrompt: z.enum(["authored", "host", "default"]),
            temperature: z.number().nullable(),
          })
          .strict(),
      })
      .strict(),
    verdictAuthority: z.literal(LOCAL_VERDICT_AUTHORITY),
    verdictPolicyVersion: z.literal(2),
    verdict: z.enum(["passed", "failed", "inconclusive", "notEstablished"]),
    decision: evalVerdictDecisionSchema.nullable(),
    termination: z.enum(["completed", "aborted", "stopped"]),
    complete: z.boolean(),
    population: z
      .object({
        unit: z.literal("case"),
        cases: z.number().int().min(0),
        configuredIterations: z.number().int().min(0),
        executedIterations: z.number().int().min(0),
        notStartedIterations: z.number().int().min(0),
      })
      .strict(),
    issues: z.array(issueSchema),
    suite: z
      .object({
        id: z.string(),
        name: z.string().optional(),
        schemaVersion: z.string(),
        sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    selection: z
      .object({
        requested: z.array(z.string()).nullable(),
        selected: z.array(z.string()),
        skipped: z.array(
          z
            .object({
              caseId: z.string(),
              reason: z.enum(["disabled", "notSelected"]),
            })
            .strict()
        ),
      })
      .strict(),
    cases: z.array(caseSchema),
    toolPolicy: z
      .object({
        declared: z
          .object({
            mode: z.enum(["default", "readOnly"]),
            allow: z.array(z.string()).optional(),
            deny: z.array(z.string()).optional(),
          })
          .strict()
          .nullable(),
        snapshot: z
          .object({
            mode: z.enum(["default", "readOnly"]),
            denied: z.record(
              z.string(),
              z
                .object({
                  reason: z.enum(TOOL_POLICY_DECISION_REASONS),
                  classification: z.enum([
                    "readOnly",
                    "destructive",
                    "unknown",
                  ]),
                })
                .strict()
            ),
            known: z.array(z.string()),
            unknownTool: z.enum(["deny", "allow"]),
          })
          .strict()
          .nullable(),
        blocks: z.array(policyBlockSchema),
      })
      .strict(),
    upload: z
      .object({
        requested: z.literal(false),
        declaredReportingMode: z.string(),
        note: z.string(),
      })
      .strict(),
    warnings: z.array(z.string()),
  })
  .strict();

export type LocalEvalRunMetadata = z.infer<typeof localEvalRunMetadataSchema>;

/** A structured report whose metadata is the validated local contract. */
export type LocalEvalRunReport = StructuredRunReport & {
  kind: typeof LOCAL_EVAL_RUN_REPORT_KIND;
  verdict: SuiteFileRunVerdict;
  metadata: LocalEvalRunMetadata;
};

/**
 * Narrow a structured report to the local contract — by kind AND by
 * validating the metadata, so a renderer never trusts an unchecked cast.
 */
export function isLocalEvalRunReport(
  report: StructuredRunReport
): report is LocalEvalRunReport {
  return (
    report.kind === LOCAL_EVAL_RUN_REPORT_KIND &&
    localEvalRunMetadataSchema.safeParse(report.metadata).success
  );
}

// ── building ─────────────────────────────────────────────────────────────────

export const LOCAL_UPLOAD_NOTE =
  "Local runs never upload eval results or artifacts; the suite file's reporting " +
  "preference is overridden for this invocation without modifying the file. " +
  "MCPJam-hosted inference, when used, still makes inference and billing requests.";

export class LocalEvalRunReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalEvalRunReportError";
  }
}

export type BuildLocalEvalRunReportInput = Omit<
  LocalEvalRunMetadata,
  | "schemaVersion"
  | "verdictAuthority"
  | "verdictPolicyVersion"
  | "upload"
  | "cases"
> & {
  declaredReportingMode: string;
  cases: SuiteFileCaseRun[];
  durationMs: number;
};

function caseVerdict(
  entry: SuiteFileCaseRun
): LocalEvalRunMetadata["cases"][number]["verdict"] {
  if (entry.aggregation) return entry.aggregation.verdict;
  return "notRun";
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function caseLine(
  entry: LocalEvalRunMetadata["cases"][number],
  decisionCase?: EvalVerdictDecision["cases"][number]
): string {
  if (!decisionCase || entry.verdict === "notRun") {
    return entry.state === "notStarted" ? "not run" : "not decided";
  }
  const unit = decisionCase.eligibleTrials === 1 ? "iteration" : "iterations";
  const measured =
    decisionCase.eligibleTrials === 0
      ? "no gradeable iterations"
      : `${decisionCase.passedTrials}/${decisionCase.eligibleTrials} gradeable ${unit} passed`;
  return `${measured} (threshold ${percent(decisionCase.effectivePassThreshold)}, ${decisionCase.configuredTrials} configured)`;
}

function structuredCase(
  entry: LocalEvalRunMetadata["cases"][number],
  decisionCase: EvalVerdictDecision["cases"][number] | undefined,
  durationMs: number
): StructuredCaseResult {
  const measuredFailure = entry.verdict === "failed";
  const failing = entry.iterations
    .filter((iteration) => iteration.taskVerdict === "failed")
    .map((iteration) => {
      const failed = iteration.scores
        .filter((score) => score.passed === false && score.role !== "advisory")
        .map((score) =>
          score.reason ? `${score.scorerId}: ${score.reason}` : score.scorerId
        );
      return `iteration ${iteration.iterationNumber}: ${failed.length > 0 ? failed.join("; ") : "failed"}`;
    });
  const notMeasured = entry.iterations
    .filter((iteration) => iteration.taskVerdict === undefined)
    .map(
      (iteration) =>
        `iteration ${iteration.iterationNumber}: ${
          iteration.evaluatorError
            ? "evaluator error"
            : iteration.status.replace("_", " ")
        }${iteration.refusal ? ` (${iteration.refusal})` : ""}${iteration.error ? ` — ${iteration.error}` : ""}`
    );
  const error =
    entry.verdict === "passed"
      ? undefined
      : entry.verdict === "failed"
        ? `${caseLine(entry, decisionCase)}. ${failing.join(" | ")}`
        : entry.verdict === "inconclusive"
          ? `Not measured: ${notMeasured.join(" | ") || "no gradeable iterations"}`
          : `Not run (${entry.state === "notStarted" ? "the run stopped before this case" : "interrupted"}).`;
  return {
    id: entry.caseId,
    title: entry.title,
    category: "eval-case",
    passed: entry.verdict === "passed",
    // Anything not measured is a diagnostic, never a regression: renderers
    // show it neutrally and JUnit files it as skipped on a neutral report.
    ...(measuredFailure || entry.verdict === "passed"
      ? {}
      : { classification: "informational" as const }),
    durationMs,
    ...(error !== undefined ? { error } : {}),
    details: {
      caseId: entry.caseId,
      verdict: entry.verdict,
      model: entry.effectiveModel,
      rail: entry.rail,
      iterations: entry.iterations.map((iteration) => ({
        iteration: iteration.iterationNumber,
        status: iteration.status,
        ...(iteration.taskVerdict
          ? { taskVerdict: iteration.taskVerdict }
          : {}),
        ...(iteration.evaluatorError ? { evaluatorError: true } : {}),
        ...(iteration.refusal ? { refusal: iteration.refusal } : {}),
        ...(iteration.error ? { error: iteration.error } : {}),
        ...(iteration.policyBlocks.length > 0
          ? {
              policyBlocks: iteration.policyBlocks.map(
                (block) => `${block.toolName}: ${block.reason}`
              ),
            }
          : {}),
      })),
    },
  };
}

function summarize(
  cases: readonly StructuredCaseResult[]
): StructuredRunSummary {
  const summary: StructuredRunSummary = {
    total: cases.length,
    passed: 0,
    failed: 0,
    byCategory: {},
  };
  for (const entry of cases) {
    const bucket = summary.byCategory[entry.category] ?? {
      total: 0,
      passed: 0,
      failed: 0,
    };
    bucket.total += 1;
    if (entry.passed) {
      summary.passed += 1;
      bucket.passed += 1;
    } else {
      summary.failed += 1;
      bucket.failed += 1;
    }
    summary.byCategory[entry.category] = bucket;
  }
  return summary;
}

/**
 * Build and VALIDATE the local report. A report that does not satisfy its own
 * contract is refused: an integrity failure, never a best-effort document.
 */
export function buildLocalEvalRunReport(
  input: BuildLocalEvalRunReportInput
): LocalEvalRunReport {
  const cases: LocalEvalRunMetadata["cases"] = input.cases.map((entry) => ({
    caseId: entry.caseId,
    title: entry.title,
    ...(entry.intent !== undefined ? { intent: entry.intent } : {}),
    ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
    isNegativeTest: entry.isNegativeTest,
    declaredModel: entry.declaredModel,
    ...(entry.declaredProvider !== undefined
      ? { declaredProvider: entry.declaredProvider }
      : {}),
    effectiveModel: entry.effectiveModel,
    rail: entry.rail,
    provider: entry.provider,
    configuredIterations: entry.configuredIterations,
    passThreshold: entry.passThreshold,
    evaluationConfigHash: entry.evaluationConfigHash,
    scorerIds: [...entry.scorerIds],
    judge: entry.judge,
    ...(entry.import ? { import: entry.import } : {}),
    state: entry.state,
    verdict: caseVerdict(entry),
    iterations: entry.iterations,
  }));
  const metadataCandidate = {
    schemaVersion: 1 as const,
    execution: input.execution,
    verdictAuthority: LOCAL_VERDICT_AUTHORITY,
    verdictPolicyVersion: 2 as const,
    verdict: input.verdict,
    decision: input.decision,
    termination: input.termination,
    complete: input.complete,
    population: input.population,
    issues: input.issues,
    suite: input.suite,
    selection: input.selection,
    cases,
    toolPolicy: input.toolPolicy,
    upload: {
      requested: false as const,
      declaredReportingMode: input.declaredReportingMode,
      note: LOCAL_UPLOAD_NOTE,
    },
    warnings: input.warnings,
  };
  const parsed = localEvalRunMetadataSchema.safeParse(metadataCandidate);
  if (!parsed.success) {
    throw new LocalEvalRunReportError(
      `the local run report failed its own contract: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    );
  }
  const metadata = parsed.data;
  const decisionCases = new Map(
    (metadata.decision?.cases ?? []).map((entry) => [entry.caseId, entry])
  );
  const durationByCase = new Map(
    input.cases.map((entry) => [
      entry.caseId,
      entry.iterations.reduce(
        (sum, iteration) => sum + iteration.durationMs,
        0
      ),
    ])
  );
  const structuredCases = metadata.cases.map((entry) =>
    structuredCase(
      entry,
      decisionCases.get(entry.caseId),
      durationByCase.get(entry.caseId) ?? 0
    )
  );
  return {
    schemaVersion: 1,
    kind: LOCAL_EVAL_RUN_REPORT_KIND,
    passed: metadata.verdict === "passed",
    verdict: metadata.verdict,
    summary: summarize(structuredCases),
    cases: structuredCases,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    metadata,
  };
}

// ── the one local formatter ──────────────────────────────────────────────────

const VERDICT_WORD: Record<SuiteFileRunVerdict, string> = {
  passed: "PASSED",
  failed: "FAILED",
  inconclusive: "INCONCLUSIVE",
  notEstablished: "NOT ESTABLISHED",
};

const TERMINATION_TEXT: Record<SuiteFileRunTermination, string> = {
  completed: "completed",
  aborted: "aborted before every planned iteration ran",
  stopped: "stopped after a credential or billing refusal",
};

function blockSummary(blocks: readonly SuiteFileToolPolicyBlock[]): string {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    const key = `${block.toolName} (${block.reason})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => `${key} ×${count}`)
    .join(", ");
}

function exclusionSummary(
  entries: readonly LocalEvalRunMetadata["cases"][number]["iterations"][number][]
): string {
  const counts = new Map<string, number>();
  for (const iteration of entries) {
    const key = iteration.evaluatorError
      ? "evaluator error"
      : `${iteration.status.replace("_", " ")}${iteration.refusal ? ` (${iteration.refusal})` : ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => `${count} ${key}`)
    .join(", ");
}

/**
 * The local decision as plain text: what the CLI prints, what JUnit carries in
 * `system-out`, and the same facts the HTML section shows. Units are named —
 * cases are decided, iterations are evidence — and nothing is recounted: the
 * verdict is the decision's, read, not derived.
 */
export function formatLocalEvalRunSummary(report: LocalEvalRunReport): string {
  const meta = report.metadata;
  const lines: string[] = [];
  const host = meta.execution.host.templateId
    ? `emulated host "${meta.execution.host.templateId}"`
    : "no host template (SDK defaults)";
  lines.push(
    `Local run — ${VERDICT_WORD[meta.verdict]} (${meta.verdictAuthority}; local execution, ${host})`
  );
  if (!meta.complete || meta.termination !== "completed") {
    lines.push(
      `  PARTIAL: the run ${TERMINATION_TEXT[meta.termination]}; ` +
        `${meta.population.notStartedIterations} of ${meta.population.configuredIterations} planned ` +
        "iterations did not run. This is not a completed release gate."
    );
  }
  const decisionCases = new Map(
    (meta.decision?.cases ?? []).map((entry) => [entry.caseId, entry])
  );
  const decided = meta.cases.filter((entry) => entry.verdict !== "notRun");
  const passedCases = meta.cases.filter(
    (entry) => entry.verdict === "passed"
  ).length;
  lines.push(
    `  Cases: ${passedCases}/${meta.cases.length} passed` +
      (decided.length < meta.cases.length
        ? `, ${meta.cases.length - decided.length} not run`
        : "") +
      ` — ${meta.population.executedIterations} of ${meta.population.configuredIterations} configured iterations executed`
  );
  const mark: Record<LocalEvalRunMetadata["cases"][number]["verdict"], string> =
    {
      passed: "PASS",
      failed: "FAIL",
      inconclusive: "N/M ",
      notRun: "SKIP",
    };
  for (const entry of meta.cases) {
    lines.push(
      `  ${mark[entry.verdict]} ${entry.caseId}  ${entry.title} — ${caseLine(entry, decisionCases.get(entry.caseId))}`
    );
    for (const iteration of entry.iterations) {
      if (iteration.taskVerdict === "failed") {
        const failed = iteration.scores
          .filter(
            (score) => score.passed === false && score.role !== "advisory"
          )
          .map((score) =>
            score.reason ? `${score.scorerId}: ${score.reason}` : score.scorerId
          );
        lines.push(
          `       iteration ${iteration.iterationNumber} failed: ${failed.join("; ") || "a gating check failed"}`
        );
      }
    }
    const unmeasured = entry.iterations.filter(
      (iteration) =>
        iteration.taskVerdict === undefined &&
        iteration.status !== "skipped" &&
        iteration.status !== "cancelled"
    );
    if (unmeasured.length > 0) {
      lines.push(`       not measured: ${exclusionSummary(unmeasured)}`);
      const firstError = unmeasured.find((iteration) => iteration.error)?.error;
      if (firstError) lines.push(`       first error: ${firstError}`);
    }
  }
  const reasons = meta.decision?.reasons ?? [];
  if (reasons.length > 0) {
    lines.push(
      `  Why: ${reasons.map((reason) => EVAL_VERDICT_DECISION_REASON_LABELS[reason]).join("; ")}`
    );
  }
  if (meta.toolPolicy.blocks.length > 0) {
    lines.push(
      `  Tool policy blocked ${meta.toolPolicy.blocks.length} call(s): ${blockSummary(meta.toolPolicy.blocks)}`
    );
  }
  const unrunJudges = meta.cases.filter(
    (entry) => entry.judge.skipReason === "localJudgeUnsupported"
  ).length;
  if (unrunJudges > 0) {
    lines.push(
      `  LLM judge: configured but not run locally for ${unrunJudges} case(s) (advisory; not part of the verdict).`
    );
  }
  if (meta.execution.declaredHosts.length > 0) {
    lines.push(
      `  Declared hosts not executed: ${meta.execution.declaredHosts.map((entry) => entry.name).join(", ")}`
    );
  }
  if (meta.execution.declaredEnvironment) {
    lines.push(
      `  Declared environment not resolved: ${meta.execution.declaredEnvironment.name}`
    );
  }
  for (const issue of meta.issues) {
    lines.push(
      `  ${issue.category} issue${issue.caseId ? ` (${issue.caseId})` : ""}: ${issue.message}`
    );
  }
  for (const warning of meta.warnings) {
    lines.push(`  warning: ${warning}`);
  }
  lines.push("  Upload: off — local runs never upload results.");
  return lines.join("\n");
}

// ── renderer hooks (used by structured-reporting.ts) ─────────────────────────

/** JUnit `<property>` pairs carrying the local provenance and state. */
export function localRunJUnitProperties(
  report: LocalEvalRunReport
): Array<[string, string]> {
  const meta = report.metadata;
  return [
    ["mcpjam.execution", meta.execution.mode],
    ["mcpjam.engine", meta.execution.engine],
    ["mcpjam.host", meta.execution.host.templateId ?? "none"],
    ["mcpjam.verdictAuthority", meta.verdictAuthority],
    ["mcpjam.verdict", meta.verdict],
    ["mcpjam.termination", meta.termination],
    ["mcpjam.complete", String(meta.complete)],
    ["mcpjam.unit", meta.population.unit],
    ["mcpjam.suite.sourceHash", meta.suite.sourceHash],
    [
      "mcpjam.judge",
      `configured-not-run:${meta.cases.filter((entry) => entry.judge.skipReason === "localJudgeUnsupported").length}`,
    ],
    ["mcpjam.upload", "off"],
  ];
}

export type LocalRunHtmlEscaper = (value: string) => string;

/** The local provenance/decision section of the HTML report. */
export function renderLocalRunHtmlSection(
  report: LocalEvalRunReport,
  escapeHtml: LocalRunHtmlEscaper
): string {
  const meta = report.metadata;
  const partial =
    !meta.complete || meta.termination !== "completed"
      ? `<p class="error">PARTIAL — the run ${escapeHtml(TERMINATION_TEXT[meta.termination])}; ${meta.population.notStartedIterations} of ${meta.population.configuredIterations} planned iterations did not run. This is not a completed release gate.</p>`
      : "";
  const reasons = (meta.decision?.reasons ?? [])
    .map(
      (reason) =>
        `<p class="note">${escapeHtml(EVAL_VERDICT_DECISION_REASON_LABELS[reason])}</p>`
    )
    .join("\n  ");
  const decisionCases = new Map(
    (meta.decision?.cases ?? []).map((entry) => [entry.caseId, entry])
  );
  const rows = meta.cases
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.caseId)}</td><td>${escapeHtml(entry.title)}</td><td>${escapeHtml(entry.verdict)}</td><td>${escapeHtml(caseLine(entry, decisionCases.get(entry.caseId)))}</td></tr>`
    )
    .join("\n");
  const unrunJudges = meta.cases.filter(
    (entry) => entry.judge.skipReason === "localJudgeUnsupported"
  ).length;
  const extras = [
    unrunJudges > 0
      ? `<p class="note">LLM judge configured but not run locally for ${unrunJudges} case(s); it is advisory and not part of this verdict.</p>`
      : "",
    meta.toolPolicy.blocks.length > 0
      ? `<p>Tool policy blocked ${meta.toolPolicy.blocks.length} call(s): ${escapeHtml(blockSummary(meta.toolPolicy.blocks))}</p>`
      : "",
    meta.execution.declaredHosts.length > 0
      ? `<p class="note">Declared hosts not executed: ${escapeHtml(meta.execution.declaredHosts.map((entry) => entry.name).join(", "))}</p>`
      : "",
    meta.execution.declaredEnvironment
      ? `<p class="note">Declared environment not resolved: ${escapeHtml(meta.execution.declaredEnvironment.name)}</p>`
      : "",
    ...meta.issues.map(
      (issue) =>
        `<p class="note">${escapeHtml(`${issue.category} issue${issue.caseId ? ` (${issue.caseId})` : ""}: ${issue.message}`)}</p>`
    ),
    ...meta.warnings.map(
      (warning) => `<p class="note">Warning: ${escapeHtml(warning)}</p>`
    ),
  ]
    .filter((part) => part.length > 0)
    .join("\n  ");
  const host = meta.execution.host.templateId
    ? `emulated host template "${meta.execution.host.templateId}"`
    : "no host template (SDK defaults)";
  return `<section class="local-run">
  <h2>Local run</h2>
  <p>Execution: <strong>local</strong>, ${escapeHtml(host)}. Verdict authority: ${escapeHtml(meta.verdictAuthority)} (policy v${meta.verdictPolicyVersion}). SDK ${escapeHtml(meta.execution.sdkVersion)}.</p>
  <p class="meta">Suite ${escapeHtml(meta.suite.id)} · source sha256 ${escapeHtml(meta.suite.sourceHash)} · upload off</p>
  ${partial}
  <p class="totals">${meta.cases.filter((entry) => entry.verdict === "passed").length}/${meta.cases.length} cases passed · ${meta.population.executedIterations}/${meta.population.configuredIterations} configured iterations executed</p>
  ${reasons}
  <table class="bucket-table">
  <caption>Cases</caption>
  <thead><tr><th>Case</th><th>Title</th><th>Verdict</th><th>Evidence</th></tr></thead>
  <tbody>
  ${rows}
  </tbody>
  </table>
  ${extras}
</section>`;
}

/** Only for tests and adapters that need the typed issue shape. */
export type LocalRunIssue = SuiteFileRunIssue;
