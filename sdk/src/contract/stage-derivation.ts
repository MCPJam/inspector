/**
 * Deriving a stage's state from one run — the output side of the user-value
 * chain vocabulary pinned in `./chain.ts`.
 *
 * `./chain.ts` deliberately stops at the enums ("pinning the derivation output
 * belongs to whoever writes the derivation"). This module is that derivation:
 * the row shape, the reason codes, and the pure function that turns one
 * iteration's authored case + captured evidence into six stage rows.
 *
 * `deriveStageResults` is PURE and deterministic — no Convex ctx, no network,
 * no LLM, no clock. Same input, same six rows, forever. The validators live at
 * the bottom of the file and the analyzer functions themselves never touch `z`,
 * so they stay trivially unit-testable (the arrangement `analyzeSession` uses
 * in `mcpjam-backend`'s `convex/lib/sessionReadiness.ts`).
 *
 * Three rules this module exists to enforce, none of which are negotiable:
 *
 *   1. **Non-vacuity.** A stage reaches `passed` only when at least one piece
 *      of eligible evidence was actually inspected. Zero evidence is
 *      `notMeasured`. This is the whole point: a chain derived from missing
 *      spans that quietly reads as green is worse than no chain at all.
 *   2. **`notReached` is derived from POSITION**, per `USER_VALUE_STAGES`
 *      order. The array is normative; this module never sorts it.
 *   3. **`evaluator` is never folded into another category.** A broken grader
 *      is not a server defect, and counting it as one poisons every rate
 *      derived from it.
 *
 * What this module deliberately does NOT do:
 *
 *   - It never derives `failureCategory: "metadata"`. That category means
 *     "tool names, descriptions or schemas misled the model", which is a
 *     judgement about intent that no span carries. Deriving it mechanically
 *     would be guessing, so it is left to a later, evidence-carrying step.
 *   - It never enforces policy. A policy block is REPRESENTED here
 *     (`notMeasured` + `blockedByPolicy`); enforcing it belongs elsewhere.
 *   - It never reads `finishReason`. That field is advisory display only and
 *     must never feed a gate (see `EvalTraceSpan.finishReason`).
 */

import { z } from "zod";
import {
  USER_VALUE_STAGES,
  failureCategorySchema,
  stageStateSchema,
  userValueStageSchema,
  type FailureCategory,
  type IterationStatus,
  type StageState,
  type UserValueStage,
} from "./chain.js";

/**
 * Bump when the derivation SEMANTICS change — not when a type moves.
 *
 * Stored on every derivation this module returns so a rebuild can target stale
 * rows (`stageAnalyzerVersion < CURRENT`). A versioned analyzer whose version
 * is not persisted cannot be recomputed selectively, which is the entire
 * reason `sessionReadiness` stamps `READINESS_ANALYZER_VERSION` on every
 * record it writes.
 */
export const STAGE_ANALYZER_VERSION = 1;

/**
 * Why a stage landed where it did.
 *
 * A closed vocabulary, for the same reason the states are: free-text reasons
 * cannot be aggregated, and "no evidence" versus "the executor emits no spans"
 * versus "an earlier stage failed" are three different operator actions.
 */
export const STAGE_REASONS = [
  // ── nothing could be measured ──
  /** The stage has no span category at all — nothing could ever be captured. */
  "noSpanChannel",
  /** A sink existed and captured nothing eligible for this stage. */
  "noEvidenceCaptured",
  /** The iteration row carries no trace whatsoever. */
  "traceAbsent",
  /** A trace exists with messages but no span channel — a custom executor. */
  "executorEmitsNoSpans",
  /** A policy prevented the run. Never `failed`: a block is not a defect. */
  "blockedByPolicy",
  /** The grader itself failed, so the run says nothing about the server. */
  "evaluatorError",
  /** The harness never got to the test (setup abort). */
  "setupAborted",
  /** The run was stopped mid-flight (cancel / timeout). */
  "lifecycleStopped",
  // ── the stage does not apply ──
  /** The authored case asserts nothing that this stage could decide. */
  "notAuthored",
  // ── position ──
  /** An earlier stage failed, so this one never ran. */
  "earlierStageFailed",
  // ── measured failures ──
  "missingToolCall",
  "unexpectedToolCall",
  "argumentMismatch",
  /** A domain error reported the protocol-correct way (`isError: true`). */
  "toolError",
  /** The call never produced a result (JSON-RPC / transport failure). */
  "protocolError",
  "renderFailed",
  "predicateFailed",
  // ── measured passes ──
  /** Positive evidence was inspected and the stage held. */
  "observed",
  /** No span proves it directly; a later stage's success implies it. */
  "impliedByLaterEvidence",
] as const;
export type StageReason = (typeof STAGE_REASONS)[number];

/** Pointers back at the evidence a row was decided from. */
export type StageEvidenceRefs = {
  spanIds?: string[];
  promptIndexes?: number[];
  predicateReasons?: string[];
};

/** One stage's verdict for one iteration. */
export type StageResultRow = {
  stage: UserValueStage;
  state: StageState;
  reason?: StageReason;
  evidence?: StageEvidenceRefs;
};

/** The full derivation for one iteration. */
export type StageDerivation = {
  /** ALWAYS six rows, in `USER_VALUE_STAGES` order. Never sorted. */
  stageResults: StageResultRow[];
  /** The FIRST failed stage, in chain order. Absent when nothing failed. */
  firstFailedStage?: UserValueStage;
  failureCategory?: FailureCategory;
  stageAnalyzerVersion: number;
};

// ── inputs ───────────────────────────────────────────────────────────────────
//
// Structural, minimal shapes rather than imports of the runner/reporting types:
// this module is consumed from the SDK, the inspector server and the client
// bundle, and a structural input keeps all three free of a shared runtime dep.
// `EvalTraceSpan` / `EvalTraceSpanInput` / `PromptTraceSummary` /
// `PredicateResult` all satisfy these by construction.

export type StageSpanLike = {
  id?: string;
  category?: string;
  status?: string;
  toolName?: string;
  promptIndex?: number;
  mcpErrorCode?: number;
};

export type StagePromptSummaryLike = {
  promptIndex?: number;
  expectedToolCalls?: readonly unknown[];
  missing?: readonly unknown[];
  unexpected?: readonly unknown[];
  argumentMismatches?: readonly unknown[];
};

export type StagePredicateResultLike = {
  passed?: boolean;
  reason?: string;
};

export type StageToolErrorLike = {
  kind?: string;
  toolName?: string;
};

export type StageRenderObservationLike = {
  status?: string;
};

/**
 * The authored case — what makes `notApplicable` derivable.
 *
 * Without this the analyzer cannot tell "this stage does not apply to this
 * case" from "this stage was not measured", and every inapplicable stage would
 * be reported as an evidence gap. Authors never toggle stages: every field
 * here is INFERRED from what the case already declares.
 */
export type StageAuthoredCase = {
  /**
   * `model_free` ⇒ no model ever chooses a tool ⇒ `selection` does not apply.
   * Inferred from the authored steps/turns (a case with no `prompt` step),
   * never authored directly.
   */
  mode: "model_driven" | "model_free";
  isNegativeTest?: boolean;
  /** The case authored at least one expected tool call. */
  expectsToolCall?: boolean;
  /** The case asserts something about a rendered widget. */
  expectsWidgetRender?: boolean;
  /** Count of authored user-value assertions (predicates, expectedOutput). */
  assertionCount?: number;
};

/** Everything the run actually captured. */
export type StageEvidence = {
  spans?: readonly StageSpanLike[];
  /**
   * True when a trace object EXISTS but carries no span channel — the
   * caller-supplied `HostExecutor` case. Distinct from `spans: []`, and the
   * difference is the difference between "we looked and saw nothing happen"
   * and "this executor never reports what happened".
   */
  traceLacksSpanChannel?: boolean;
  /** True when the iteration carries no trace at all. */
  traceAbsent?: boolean;
  prompts?: readonly StagePromptSummaryLike[];
  predicateResults?: readonly StagePredicateResultLike[];
  toolErrors?: readonly StageToolErrorLike[];
  renderObservations?: readonly StageRenderObservationLike[];
  /** `tools_total_before` / `tools_exposed` — the one direct discovery signal. */
  toolSignals?: { toolsTotalBefore?: number; toolsExposed?: number };
  /** The grader threw. Never folded into a server-side category. */
  evaluatorErrored?: boolean;
};

export type StageDerivationInput = {
  authored: StageAuthoredCase;
  evidence: StageEvidence;
  iteration: { status: IterationStatus; error?: string };
  /** D1 only REPRESENTS a policy block; enforcing one is a different step. */
  policy?: { blocked: boolean; reason?: string };
};

// ── helpers (pure, no `z`) ───────────────────────────────────────────────────

/**
 * MCP-SDK-local codes. `-32000` (connection closed) and `-32001` (request
 * timeout) are CLIENT-side transport/lifecycle conditions, not server faults,
 * and cannot be distinguished from a server fault by code alone. A failure
 * carrying only these is attributed to `setup`, never to `serverData`.
 */
const TRANSPORT_LOCAL_MCP_CODES = new Set([-32000, -32001]);

const isToolSpan = (s: StageSpanLike) => s.category === "tool";
const spanFailed = (s: StageSpanLike) =>
  s.status === "error" || typeof s.mcpErrorCode === "number";

const nonEmpty = (v: readonly unknown[] | undefined) => (v?.length ?? 0) > 0;

const spanIds = (spans: readonly StageSpanLike[]): string[] =>
  spans.map((s) => s.id).filter((id): id is string => typeof id === "string");

const row = (
  stage: UserValueStage,
  state: StageState,
  reason?: StageReason,
  evidence?: StageEvidenceRefs
): StageResultRow => ({
  stage,
  state,
  ...(reason ? { reason } : {}),
  ...(evidence && Object.keys(evidence).length > 0 ? { evidence } : {}),
});

/** Iteration statuses that mean "no verdict was ever produced". */
const LIFECYCLE_STOPPED: ReadonlySet<IterationStatus> =
  new Set<IterationStatus>([
    "cancelled",
    "timed_out",
    "setup_failed",
    "skipped",
  ]);

/**
 * Which stages this case can say anything about at all.
 *
 * Computed BEFORE any evidence is read, so an inapplicable stage can never be
 * reported as an evidence gap.
 */
function applicability(
  authored: StageAuthoredCase
): Record<UserValueStage, boolean> {
  // A case that expects no tool call but IS a negative case still exercises
  // `call`: proving no call happened is the assertion.
  const callApplies =
    authored.expectsToolCall === true || authored.isNegativeTest === true;
  return {
    // Every run must reach a server and read its tools, whatever it asserts.
    connection: true,
    discovery: true,
    selection: authored.mode === "model_driven",
    call: callApplies,
    // A case asserting a rendered widget has something for `response` to decide
    // even when it authors no expected tool call — `deriveResponse` reads the
    // render observations directly. Gating this on `callApplies` alone would
    // make `renderFailed` unreachable for a pure render probe.
    response: callApplies || authored.expectsWidgetRender === true,
    userValue:
      (authored.assertionCount ?? 0) > 0 ||
      authored.expectsWidgetRender === true,
  };
}

// ── per-stage evaluators ─────────────────────────────────────────────────────

function deriveConnection(e: StageEvidence): StageResultRow {
  const tools = (e.spans ?? []).filter(isToolSpan);
  // A tool span that is not a transport-local failure proves we reached the
  // server. This is retroactive, and it is the ONLY positive signal available:
  // there is no `connection` span category anywhere in the span contract.
  const reached = tools.filter(
    (s) =>
      !(
        typeof s.mcpErrorCode === "number" &&
        TRANSPORT_LOCAL_MCP_CODES.has(s.mcpErrorCode)
      )
  );
  if (reached.length > 0) {
    return row("connection", "passed", "impliedByLaterEvidence", {
      spanIds: spanIds(reached).slice(0, 5),
    });
  }
  if ((e.toolSignals?.toolsTotalBefore ?? 0) > 0) {
    return row("connection", "passed", "impliedByLaterEvidence");
  }
  if (e.traceAbsent) return row("connection", "notMeasured", "traceAbsent");
  // Not `noEvidenceCaptured`: there is no channel to capture on, so no amount
  // of instrumentation on the current contract would have decided this.
  return row("connection", "notMeasured", "noSpanChannel");
}

function deriveDiscovery(e: StageEvidence): StageResultRow {
  if ((e.toolSignals?.toolsTotalBefore ?? 0) > 0) {
    return row("discovery", "passed", "observed");
  }
  const tools = (e.spans ?? []).filter(isToolSpan);
  if (tools.length > 0) {
    // We called a tool, so it must have been discovered.
    return row("discovery", "passed", "impliedByLaterEvidence", {
      spanIds: spanIds(tools).slice(0, 5),
    });
  }
  if (e.traceAbsent) return row("discovery", "notMeasured", "traceAbsent");
  return row("discovery", "notMeasured", "noSpanChannel");
}

function deriveSelection(e: StageEvidence): StageResultRow {
  const prompts = e.prompts ?? [];
  if (prompts.length > 0) {
    const missing = prompts.filter((p) => nonEmpty(p.missing));
    if (missing.length > 0) {
      return row("selection", "failed", "missingToolCall", {
        promptIndexes: missing
          .map((p) => p.promptIndex)
          .filter((i): i is number => typeof i === "number"),
      });
    }
    const unexpected = prompts.filter((p) => nonEmpty(p.unexpected));
    if (unexpected.length > 0) {
      return row("selection", "failed", "unexpectedToolCall", {
        promptIndexes: unexpected
          .map((p) => p.promptIndex)
          .filter((i): i is number => typeof i === "number"),
      });
    }
    return row("selection", "passed", "observed");
  }
  if (e.traceAbsent) return row("selection", "notMeasured", "traceAbsent");
  if (e.traceLacksSpanChannel) {
    return row("selection", "notMeasured", "executorEmitsNoSpans");
  }
  return row("selection", "notMeasured", "noEvidenceCaptured");
}

function deriveCall(e: StageEvidence): StageResultRow {
  const mismatched = (e.prompts ?? []).filter((p) =>
    nonEmpty(p.argumentMismatches)
  );
  if (mismatched.length > 0) {
    return row("call", "failed", "argumentMismatch", {
      promptIndexes: mismatched
        .map((p) => p.promptIndex)
        .filter((i): i is number => typeof i === "number"),
    });
  }
  const tools = (e.spans ?? []).filter(isToolSpan);
  // A call that never produced a result: a JSON-RPC/transport failure carries
  // an `mcpErrorCode`; a DOMAIN error (`isError: true`) carries none by spec,
  // and belongs to `response`, not here.
  const protocolFailed = tools.filter(
    (s) => typeof s.mcpErrorCode === "number"
  );
  const protocolToolErrors = (e.toolErrors ?? []).filter(
    (t) => t.kind === "protocol-error"
  );
  if (protocolFailed.length > 0 || protocolToolErrors.length > 0) {
    return row("call", "failed", "protocolError", {
      spanIds: spanIds(protocolFailed).slice(0, 5),
    });
  }
  if (tools.length > 0) {
    return row("call", "passed", "observed", {
      spanIds: spanIds(tools).slice(0, 5),
    });
  }
  if (e.traceAbsent) return row("call", "notMeasured", "traceAbsent");
  if (e.traceLacksSpanChannel) {
    return row("call", "notMeasured", "executorEmitsNoSpans");
  }
  return row("call", "notMeasured", "noEvidenceCaptured");
}

function deriveResponse(
  e: StageEvidence,
  authored: StageAuthoredCase
): StageResultRow {
  const contentErrors = (e.toolErrors ?? []).filter(
    (t) => t.kind === "content-error"
  );
  // An errored tool span with NO code is a domain error reported the
  // protocol-correct way: the server answered, with unusable data.
  const domainFailed = (e.spans ?? []).filter(
    (s) => isToolSpan(s) && spanFailed(s) && typeof s.mcpErrorCode !== "number"
  );
  if (contentErrors.length > 0 || domainFailed.length > 0) {
    return row("response", "failed", "toolError", {
      spanIds: spanIds(domainFailed).slice(0, 5),
    });
  }
  if (authored.expectsWidgetRender) {
    const observations = e.renderObservations ?? [];
    if (observations.length === 0) {
      return row("response", "notMeasured", "noEvidenceCaptured");
    }
    // Only `"rendered"` is success; every other literal names the stage that
    // failed (`no_ui_resource`, `mount_failed`, `bridge_timeout`, …).
    if (observations.some((o) => o.status !== "rendered")) {
      return row("response", "failed", "renderFailed");
    }
    return row("response", "passed", "observed");
  }
  const okTools = (e.spans ?? []).filter(
    (s) => isToolSpan(s) && !spanFailed(s)
  );
  if (okTools.length > 0) {
    return row("response", "passed", "observed", {
      spanIds: spanIds(okTools).slice(0, 5),
    });
  }
  if (e.traceAbsent) return row("response", "notMeasured", "traceAbsent");
  if (e.traceLacksSpanChannel) {
    return row("response", "notMeasured", "executorEmitsNoSpans");
  }
  return row("response", "notMeasured", "noEvidenceCaptured");
}

function deriveUserValue(e: StageEvidence): StageResultRow {
  // Precedence: a broken grader outranks whatever it would have said. The run
  // says nothing about the server's user value, so `notMeasured` — never
  // `failed`, which would blame the server for our own bug.
  if (e.evaluatorErrored) {
    return row("userValue", "notMeasured", "evaluatorError");
  }
  const results = e.predicateResults ?? [];
  if (results.length > 0) {
    const failed = results.filter((r) => r.passed === false);
    if (failed.length > 0) {
      return row("userValue", "failed", "predicateFailed", {
        predicateReasons: failed
          .map((r) => r.reason)
          .filter((r): r is string => typeof r === "string")
          .slice(0, 5),
      });
    }
    return row("userValue", "passed", "observed");
  }
  if (e.traceAbsent) return row("userValue", "notMeasured", "traceAbsent");
  return row("userValue", "notMeasured", "noEvidenceCaptured");
}

/**
 * The coarse bucket a failing run is grouped under.
 *
 * `metadata` is never produced (see the module docblock). `evaluator` is only
 * reached when the grader is the ONLY thing that broke — a run whose server
 * demonstrably failed is reported against the server, and an evaluator error
 * on top of that does not launder it.
 */
function categoryFor(
  firstFailed: UserValueStage | undefined,
  rows: readonly StageResultRow[],
  evidence: StageEvidence
): FailureCategory | undefined {
  if (!firstFailed) {
    return evidence.evaluatorErrored ? "evaluator" : undefined;
  }
  const failedRow = rows.find((r) => r.stage === firstFailed);
  switch (firstFailed) {
    case "connection":
    case "discovery":
      return "setup";
    case "selection":
      return "selection";
    case "call":
      if (failedRow?.reason === "argumentMismatch") return "arguments";
      // A transport-local code is OUR side, not the server's.
      return (evidence.spans ?? []).some(
        (s) =>
          typeof s.mcpErrorCode === "number" &&
          TRANSPORT_LOCAL_MCP_CODES.has(s.mcpErrorCode)
      )
        ? "setup"
        : "serverData";
    case "response":
      return "serverData";
    case "userValue":
      return "userValue";
  }
}

/**
 * Derive the six stage rows for one iteration.
 *
 * Pure and deterministic. Always returns exactly six rows in
 * `USER_VALUE_STAGES` order — position is how `notReached` is derived, so the
 * result must never be sorted or re-slotted by a caller.
 */
export function deriveStageResults(
  input: StageDerivationInput
): StageDerivation {
  const { authored, evidence, iteration, policy } = input;
  const applies = applicability(authored);

  const inapplicable = (stage: UserValueStage) =>
    row(stage, "notApplicable", "notAuthored");

  // Precedence 1: a policy block. Nothing was measured and nothing failed —
  // representing it as a failure would blame the server for our own gate.
  if (policy?.blocked) {
    return finalize(
      USER_VALUE_STAGES.map((stage) =>
        applies[stage]
          ? row(stage, "notMeasured", "blockedByPolicy")
          : inapplicable(stage)
      ),
      evidence
    );
  }

  // Precedence 2: the run never produced a verdict. Harness noise must not
  // inflate any server failure rate, so nothing here is ever `failed`.
  if (LIFECYCLE_STOPPED.has(iteration.status)) {
    const reason: StageReason =
      iteration.status === "setup_failed" ? "setupAborted" : "lifecycleStopped";
    return finalize(
      USER_VALUE_STAGES.map((stage) =>
        applies[stage] ? row(stage, "notMeasured", reason) : inapplicable(stage)
      ),
      evidence,
      "setup"
    );
  }

  // A `failed` row with no trace at all is a setup abort wearing the only
  // status the current writer can spell (`persistSetupFailedIteration` writes
  // `status: "failed"` because the update mutation rejects `setup_failed`).
  const noEvidenceAtAll =
    (evidence.spans?.length ?? 0) === 0 &&
    (evidence.prompts?.length ?? 0) === 0 &&
    (evidence.predicateResults?.length ?? 0) === 0;
  if (
    iteration.status === "failed" &&
    evidence.traceAbsent &&
    noEvidenceAtAll
  ) {
    return finalize(
      USER_VALUE_STAGES.map((stage) =>
        applies[stage]
          ? row(stage, "notMeasured", "setupAborted")
          : inapplicable(stage)
      ),
      evidence,
      "setup"
    );
  }

  const derived: StageResultRow[] = USER_VALUE_STAGES.map((stage) => {
    if (!applies[stage]) return inapplicable(stage);
    switch (stage) {
      case "connection":
        return deriveConnection(evidence);
      case "discovery":
        return deriveDiscovery(evidence);
      case "selection":
        return deriveSelection(evidence);
      case "call":
        return deriveCall(evidence);
      case "response":
        return deriveResponse(evidence, authored);
      case "userValue":
        return deriveUserValue(evidence);
    }
  });

  // Precedence 3: position. Every stage after the FIRST failure never ran, so
  // whatever it computed for itself is overwritten — the chain broke upstream.
  const firstFailedIndex = derived.findIndex((r) => r.state === "failed");
  const rows =
    firstFailedIndex < 0
      ? derived
      : derived.map((r, i) =>
          i > firstFailedIndex && r.state !== "notApplicable"
            ? row(r.stage, "notReached", "earlierStageFailed")
            : r
        );

  return finalize(rows, evidence);
}

function finalize(
  rows: StageResultRow[],
  evidence: StageEvidence,
  forcedCategory?: FailureCategory
): StageDerivation {
  const firstFailedStage = rows.find((r) => r.state === "failed")?.stage;
  const failureCategory =
    forcedCategory ?? categoryFor(firstFailedStage, rows, evidence);
  return {
    stageResults: rows,
    ...(firstFailedStage ? { firstFailedStage } : {}),
    ...(failureCategory ? { failureCategory } : {}),
    stageAnalyzerVersion: STAGE_ANALYZER_VERSION,
  };
}

// ── validators ───────────────────────────────────────────────────────────────
//
// The single source of truth for what a PERSISTED derivation may look like,
// used at every write boundary that accepts one from a client. Kept beside the
// analyzer (which never references them) so the two cannot drift.

export const stageReasonSchema = z.enum(STAGE_REASONS);

export const stageResultRowSchema = z.object({
  stage: userValueStageSchema,
  state: stageStateSchema,
  reason: stageReasonSchema.optional(),
  evidence: z
    .object({
      spanIds: z.array(z.string()).optional(),
      promptIndexes: z.array(z.number()).optional(),
      predicateReasons: z.array(z.string()).optional(),
    })
    .optional(),
});

/**
 * A derivation as persisted.
 *
 * The `superRefine` is the load-bearing part: it re-asserts the two invariants
 * that make the rows readable at all — exactly six rows, in `USER_VALUE_STAGES`
 * order. A payload that arrives sorted alphabetically would otherwise validate
 * field-by-field while reporting a completely different set of blocked stages.
 */
export const stageDerivationSchema = z
  .object({
    stageResults: z.array(stageResultRowSchema),
    firstFailedStage: userValueStageSchema.optional(),
    failureCategory: failureCategorySchema.optional(),
    stageAnalyzerVersion: z.number().int().nonnegative(),
  })
  .superRefine((value, ctx) => {
    if (value.stageResults.length !== USER_VALUE_STAGES.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stageResults"],
        message: `expected ${USER_VALUE_STAGES.length} stage rows, received ${value.stageResults.length}`,
      });
      return;
    }
    USER_VALUE_STAGES.forEach((stage, index) => {
      if (value.stageResults[index]?.stage !== stage) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stageResults", index, "stage"],
          message: `stage rows must be in USER_VALUE_STAGES order; expected "${stage}" at index ${index}`,
        });
      }
    });
    const firstFailed = value.stageResults.find((r) => r.state === "failed");
    if (firstFailed && value.firstFailedStage !== firstFailed.stage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["firstFailedStage"],
        message: `firstFailedStage must name the first failed row ("${firstFailed.stage}")`,
      });
    }
    if (!firstFailed && value.firstFailedStage !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["firstFailedStage"],
        message: "firstFailedStage is set but no stage row failed",
      });
    }
  });

/**
 * The metadata keys a derivation occupies on `testIteration.metadata`.
 *
 * Exported so every writer and every validator names them identically rather
 * than spelling the strings again.
 */
export const STAGE_METADATA_KEYS = [
  "stageResults",
  "firstFailedStage",
  "failureCategory",
  "stageAnalyzerVersion",
] as const;

/** Flatten a derivation into the metadata keys it persists under. */
export function stageDerivationToMetadata(
  derivation: StageDerivation
): Record<string, unknown> {
  return {
    stageResults: derivation.stageResults,
    ...(derivation.firstFailedStage
      ? { firstFailedStage: derivation.firstFailedStage }
      : {}),
    ...(derivation.failureCategory
      ? { failureCategory: derivation.failureCategory }
      : {}),
    stageAnalyzerVersion: derivation.stageAnalyzerVersion,
  };
}
