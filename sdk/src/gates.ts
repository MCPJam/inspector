/**
 * The gate engine: one implementation shared by the SDK (`assertGate` in a
 * code-first run) and the CLI (`mcpjam cloud eval gate` against a hosted run).
 *
 * Everything upstream is normalized into {@link GateInput} first. Two surfaces
 * evaluating "did this run pass?" with two subtly different implementations is
 * how a CI gate ends up green on one path and red on the other, so there is
 * exactly one evaluator and three adapters into it.
 *
 * Rates are FRACTIONS (0–1) everywhere inside this module. Percent lives only
 * at the boundary — a CLI flag or a legacy config field — and every such field
 * is named `*Percent` so a bare `minimumPassRate: 100` cannot be mistaken for
 * "100%" when it means "10000%".
 */

import type { EvalRunResult } from "./EvalTest.js";
import type { EvalSuiteResult } from "./EvalSuite.js";
import type {
  EvaluationConfigSnapshot,
  ResolvedScoreDefinition,
  ScoreResult,
} from "./contract/types.js";
import { definitionHash, evaluationConfigHash } from "./contract/derive.js";
import { calculateLatencyStats } from "./percentiles.js";
import type {
  PlatformEvalIteration,
  PlatformEvalRun,
} from "./platform/types.js";
import type { StructuredRunVerdict } from "./structured-reporting.js";

/** Whether a run's score evidence verified at ingest. */
export type ScoreIntegrity = "valid" | "invalid";

/** Just enough of a {@link ScoreResult} to evaluate a gate against it. */
export type GateScore = Pick<
  ScoreResult,
  "scorerId" | "definitionHash" | "status" | "value" | "passed"
>;

export type GateInput = {
  iterations: { total: number; passed: number };
  /** Joins `scores` to the definitions that say whether each one gates. */
  evaluationConfig?: EvaluationConfigSnapshot;
  scores?: GateScore[];
  /**
   * TRI-STATE. `undefined` is NOT "fine" — it means no integrity verdict was
   * produced, and a score gate treats it exactly like `"invalid"`. See
   * {@link scoreGateability}.
   */
  scoreIntegrity?: ScoreIntegrity;
  /**
   * Whole-run totals. A field absent here makes its gate NON-GATEABLE rather
   * than passing: a token cap evaluated against a partial token count is a
   * gate that reports green for the wrong reason.
   */
  totals?: { tokens?: number; e2eP95Ms?: number };
};

export type GatePolicy = {
  /** FRACTION in [0,1]. `1` means every iteration must pass. */
  minimumPassRate?: number;
  maximumTotalTokens?: number;
  maximumP95LatencyMs?: number;
  /** Fail if any GATING scorer errored anywhere in the run. */
  noGatingScoreErrors?: boolean;
  /** Per-scorer pass rate, keyed by STABLE scorerId. Values are fractions. */
  minimumScorerPassRate?: Record<string, number>;
  /** Per-scorer mean of `value` over scored rows, keyed by stable scorerId. */
  minimumMeanScore?: Record<string, number>;
  // No `maximumCostUsd`: there is no price source yet, and a cost gate that
  // silently evaluates against zero is worse than no cost gate. The name is
  // reserved. `maximumCostIncrease` — its comparative twin — is reserved for
  // the same reason and on the same condition.

  // ── comparative gates ────────────────────────────────────────────────────
  // These need a BASELINE and are evaluated by `evaluateCompareGates`, not by
  // `evaluateGates`. Passing one to the single-run evaluator is a usage error,
  // never a silent no-op: a policy that says "fail on regressions" and is then
  // ignored is worse than no policy, because CI reports green either way.

  /** Fail if any deterministic gating scorer flipped passed -> failed. */
  noDeterministicRegressions?: boolean;
  /** Fail if p95 e2e latency rose by more than this many ms. */
  maximumP95LatencyIncreaseMs?: number;
  /** Statistical pass-rate regression. Fractions; see `compare-stats.ts`. */
  passRateRegression?: {
    minSampleSize?: number;
    minEffectSize?: number;
  };
};

/**
 * The comparative fields, listed once so the single-run evaluator can fail
 * closed on every one of them without a second list to forget to update.
 */
export const COMPARATIVE_GATE_FIELDS = [
  "noDeterministicRegressions",
  "maximumP95LatencyIncreaseMs",
  "passRateRegression",
] as const satisfies ReadonlyArray<keyof GatePolicy>;

// FROZEN, not merely `as const`: this array decides which policy fields
// `evaluateGates` refuses to evaluate silently, and `as const` is a
// compile-time claim that a runtime `push` would quietly break — turning a
// fail-closed guard into a hole in exactly the surface it protects.
Object.freeze(COMPARATIVE_GATE_FIELDS);

export type GateStatus =
  /** Evidence present, threshold met. */
  | "passed"
  /** Evidence present, threshold missed. */
  | "failed"
  /**
   * The gate could not be decided — missing evidence, or evidence that did not
   * verify. Never a pass, and deliberately distinct from `failed`: "the server
   * regressed" and "we established nothing" have different fixes.
   */
  | "non_gateable"
  /** The policy itself is wrong (unknown scorer, unstable id, bad range). */
  | "usage_error";

export type GateVerdict = {
  /** e.g. `"minimumPassRate"`, `"minimumScorerPassRate:tone"`. */
  gate: string;
  status: GateStatus;
  message: string;
  observed?: number;
  threshold?: number;
};

export type GateReport = {
  outcome: "passed" | "failed" | "incomplete" | "usage_error";
  verdicts: GateVerdict[];
  /** `"unknown"` renders the `undefined` tri-state honestly for a human. */
  scoreIntegrity: ScoreIntegrity | "unknown";
};

/**
 * Whether score-derived gates may be evaluated at all.
 *
 * Written as an EXHAUSTIVE switch, not `if (integrity === "invalid")`. The
 * whole point of the tri-state is that the third state is the dangerous one: a
 * backend that does not yet verify score integrity produces no verdict, and an
 * `if`-shaped check would let that absence read as valid evidence and hand back
 * a green gate on unverified scores.
 */
function scoreGateability(
  integrity: ScoreIntegrity | undefined
): "gateable" | "non_gateable" {
  switch (integrity) {
    case "valid":
      return "gateable";
    case "invalid":
      return "non_gateable";
    case undefined:
      return "non_gateable";
    default: {
      const exhaustive: never = integrity;
      void exhaustive;
      return "non_gateable";
    }
  }
}

function integrityReason(integrity: ScoreIntegrity | undefined): string {
  return integrity === "invalid"
    ? "the run's score evidence did not verify at ingest"
    : "the run carries no score-integrity verdict, so its scores cannot be " +
        "trusted to gate (absent evidence is not valid evidence)";
}

// ─────────────────────────────────────────────────────────────── adapters ──

function scoresFromIterations(
  iterations: Array<{ scores?: ScoreResult[] }>
): GateScore[] {
  return iterations.flatMap((iteration) =>
    (iteration.scores ?? []).map((score) => ({
      scorerId: score.scorerId,
      definitionHash: score.definitionHash,
      status: score.status,
      value: score.value,
      passed: score.passed,
    }))
  );
}

export function gateInputFromRunResult(result: EvalRunResult): GateInput {
  return {
    iterations: { total: result.iterations, passed: result.successes },
    ...(result.evaluationConfig
      ? { evaluationConfig: result.evaluationConfig }
      : {}),
    scores: scoresFromIterations(result.iterationDetails),
    // A locally-produced run needs no integrity check: the scores were minted
    // in this process by `finalizeScoreResult` and never crossed a boundary
    // where they could be substituted.
    scoreIntegrity: "valid",
    totals: {
      tokens: result.tokenUsage.total,
      e2eP95Ms: result.latency.e2e.p95,
    },
  };
}

export function gateInputFromSuiteResult(result: EvalSuiteResult): GateInput {
  const runs = Array.from(result.tests.values());
  // A suite grades each case with its own definition set. Merge them into one
  // snapshot, deduplicated by definition hash — every score row's join key
  // still resolves, and the shared built-ins (`legacy:test`, `tool-match`)
  // collapse to one entry instead of appearing once per case.
  const byHash = new Map<string, ResolvedScoreDefinition>();
  for (const run of runs) {
    for (const definition of run.evaluationConfig?.definitions ?? []) {
      byHash.set(definitionHash(definition), definition);
    }
  }
  const definitions = [...byHash.values()];

  return {
    iterations: {
      total: result.aggregate.iterations,
      passed: result.aggregate.successes,
    },
    ...(definitions.length > 0
      ? {
          evaluationConfig: {
            // Computed over the MERGED set, so the hash actually describes the
            // definitions it ships with. It is deliberately not equal to any
            // one case's `evaluationConfigHash` — a suite has no single one —
            // but a snapshot whose hash does not describe its own contents is
            // a lie waiting to be verified against.
            hash: evaluationConfigHash(definitions),
            definitions,
          },
        }
      : {}),
    scores: runs.flatMap((run) => scoresFromIterations(run.iterationDetails)),
    scoreIntegrity: "valid",
    totals: {
      tokens: result.aggregate.tokenUsage.total,
      e2eP95Ms: result.aggregate.latency.e2e.p95,
    },
  };
}

/**
 * Build a gate input from a hosted run.
 *
 * The run summary alone carries pass/fail counts and nothing else, so score
 * gates need the iterations page too. `iterations.complete` is load-bearing:
 * an INCOMPLETE page yields no totals and no scores, so a token or score gate
 * reports `non_gateable` rather than passing against a partial sample. Silently
 * gating on page one is exactly the kind of green that means nothing.
 */
export function gateInputFromPlatformRun(
  run: PlatformEvalRun,
  iterations?: { items: PlatformEvalIteration[]; complete: boolean }
): GateInput {
  const total = run.summary?.total ?? 0;
  const passed = run.summary?.passed ?? 0;
  const integrity =
    run.scoreIntegrity === "valid" || run.scoreIntegrity === "invalid"
      ? run.scoreIntegrity
      : undefined;

  const usable = iterations?.complete ? iterations.items : [];

  // Merge every iteration's definitions: a suite run grades different cases
  // with different scorers, and a policy naming one of them must still resolve.
  const byHash = new Map<string, ResolvedScoreDefinition>();
  for (const iteration of usable) {
    for (const definition of iteration.evaluationConfig?.definitions ?? []) {
      byHash.set(definitionHash(definition), definition);
    }
  }
  const merged = [...byHash.values()];

  // A single iteration missing its token count makes the SUM wrong, not
  // merely smaller — and a token cap evaluated against an undercount passes
  // for the wrong reason. Absent beats approximate: the gate reports
  // non-gateable instead.
  const tokenCounts = usable.map((iteration) => iteration.tokensUsed);
  const tokens = tokenCounts.every((count) => typeof count === "number")
    ? (tokenCounts as number[]).reduce((sum, count) => sum + count, 0)
    : undefined;

  // Same rule for latency: p95 over a partial set is not this run's p95.
  const durations = usable.map((iteration) => iteration.durationMs);
  const e2eP95Ms =
    durations.length > 0 && durations.every((ms) => typeof ms === "number")
      ? calculateLatencyStats(durations as number[]).p95
      : undefined;

  return {
    iterations: { total, passed },
    ...(merged.length > 0
      ? {
          evaluationConfig: {
            hash: evaluationConfigHash(merged),
            definitions: merged,
          },
        }
      : {}),
    ...(iterations?.complete
      ? {
          scores: scoresFromIterations(
            usable.map((iteration) => ({
              scores: iteration.scores ?? undefined,
            }))
          ),
          totals: {
            ...(tokens !== undefined ? { tokens } : {}),
            ...(e2eP95Ms !== undefined ? { e2eP95Ms } : {}),
          },
        }
      : {}),
    ...(integrity ? { scoreIntegrity: integrity } : {}),
  };
}

// ──────────────────────────────────────────────────────────────── engine ──

function definitionsById(
  config: EvaluationConfigSnapshot | undefined
): Map<string, ResolvedScoreDefinition> {
  const byId = new Map<string, ResolvedScoreDefinition>();
  for (const definition of config?.definitions ?? []) {
    byId.set(definition.scorerId, definition);
  }
  return byId;
}

/**
 * Resolve a scorerId named by a policy. Returns a usage error rather than a
 * failure for anything the AUTHOR got wrong — a typo'd scorer must not read as
 * a regression, and a positional id must not be gateable at all.
 */
function resolveScorer(
  scorerId: string,
  byId: Map<string, ResolvedScoreDefinition>,
  gate: string
): { ok: true; definition: ResolvedScoreDefinition } | { ok: false; verdict: GateVerdict } {
  const definition = byId.get(scorerId);
  if (!definition) {
    return {
      ok: false,
      verdict: {
        gate,
        status: "usage_error",
        message:
          `no scorer "${scorerId}" in this run's evaluation config ` +
          `(available: ${[...byId.keys()].join(", ") || "none"})`,
      },
    };
  }
  if (definition.idSource === "generated") {
    return {
      ok: false,
      verdict: {
        gate,
        status: "usage_error",
        message:
          `scorer "${scorerId}" has a generated, positional id — it renumbers ` +
          `when the scorer list changes, so it cannot be gated on. Give the ` +
          `scorer an explicit id.`,
      },
    };
  }
  return { ok: true, definition };
}

function rowsFor(scores: GateScore[], scorerId: string): GateScore[] {
  return scores.filter((score) => score.scorerId === scorerId);
}

/** `not_applicable` is excluded from EVERY denominator — that is what it means. */
function countable(rows: GateScore[]): GateScore[] {
  return rows.filter((row) => row.status !== "not_applicable");
}

function threshold(gate: string, value: number): GateVerdict | null {
  if (Number.isFinite(value) && value >= 0 && value <= 1) return null;
  return {
    gate,
    status: "usage_error",
    message: `threshold must be a fraction in [0,1], got ${value}`,
  };
}

export function evaluateGates(
  input: GateInput,
  policy: GatePolicy
): GateReport {
  const verdicts: GateVerdict[] = [];
  const scores = input.scores ?? [];
  const byId = definitionsById(input.evaluationConfig);
  const byHash = new Map(
    (input.evaluationConfig?.definitions ?? []).map((definition) => [
      definitionHash(definition),
      definition,
    ])
  );
  const gateability = scoreGateability(input.scoreIntegrity);
  /**
   * Without the definition snapshot, NO score gate is decidable — not even
   * "did any gating scorer error", because gating is a property of the
   * definitions and every row would silently read as advisory. That is a
   * fail-OPEN, so it is checked before any score gate computes anything.
   */
  const hasSnapshot = (input.evaluationConfig?.definitions.length ?? 0) > 0;
  const noSnapshot: GateVerdict["message"] =
    "this run carries no evaluation config, so its scores cannot be resolved " +
    "to definitions (whether each one gates is unknown)";

  // ── comparative fields fail CLOSED here. Silently ignoring a policy that
  // asks about a baseline this evaluator does not have would report green for
  // a question nobody answered — the exact failure mode a gate exists to
  // prevent. A usage error is loud and unambiguous.
  for (const field of COMPARATIVE_GATE_FIELDS) {
    const value = policy[field];
    // `undefined` is "not asked for"; an explicit `false` is "asked for, and
    // disabled" — the same semantics `noGatingScoreErrors` already has. Note
    // this deliberately does NOT skip falsy in general:
    // `maximumP95LatencyIncreaseMs: 0` is a real, strict threshold.
    if (
      value === undefined ||
      // `false` disables the BOOLEAN gate only. `false` on a numeric or object
      // field is a malformed policy, not an opt-out, and must stay loud.
      (field === "noDeterministicRegressions" && value === false)
    ) {
      continue;
    }
    verdicts.push({
      gate: field,
      status: "usage_error",
      message:
        `"${field}" is a comparative gate and requires a baseline run — ` +
        `use evaluateCompareGates() or \`mcpjam cloud eval compare\`. ` +
        `evaluateGates() sees one run and cannot decide it.`,
    });
  }

  // ── pass rate: never depends on scores, so it works with no integrity
  // verdict at all. This is what makes a pass-rate gate usable before the
  // backend learns to verify score evidence.
  if (policy.minimumPassRate !== undefined) {
    const bad = threshold("minimumPassRate", policy.minimumPassRate);
    if (bad) {
      verdicts.push(bad);
    } else if (input.iterations.total <= 0) {
      verdicts.push({
        gate: "minimumPassRate",
        status: "non_gateable",
        message: "the run reported no iterations",
        threshold: policy.minimumPassRate,
      });
    } else {
      const rate = input.iterations.passed / input.iterations.total;
      verdicts.push({
        gate: "minimumPassRate",
        status: rate >= policy.minimumPassRate ? "passed" : "failed",
        message: `${input.iterations.passed}/${input.iterations.total} iterations passed`,
        observed: rate,
        threshold: policy.minimumPassRate,
      });
    }
  }

  if (policy.maximumTotalTokens !== undefined) {
    const observed = input.totals?.tokens;
    verdicts.push(
      observed === undefined
        ? {
            gate: "maximumTotalTokens",
            status: "non_gateable",
            message: "no complete token total is available for this run",
            threshold: policy.maximumTotalTokens,
          }
        : {
            gate: "maximumTotalTokens",
            status:
              observed <= policy.maximumTotalTokens ? "passed" : "failed",
            message: `${observed} tokens used`,
            observed,
            threshold: policy.maximumTotalTokens,
          }
    );
  }

  if (policy.maximumP95LatencyMs !== undefined) {
    const observed = input.totals?.e2eP95Ms;
    verdicts.push(
      observed === undefined
        ? {
            gate: "maximumP95LatencyMs",
            status: "non_gateable",
            message: "no p95 latency is available for this run",
            threshold: policy.maximumP95LatencyMs,
          }
        : {
            gate: "maximumP95LatencyMs",
            status:
              observed <= policy.maximumP95LatencyMs ? "passed" : "failed",
            message: `p95 e2e latency ${observed}ms`,
            observed,
            threshold: policy.maximumP95LatencyMs,
          }
    );
  }

  // ── score-derived gates. Usage errors in the POLICY are reported even when
  // the run is non-gateable: a typo is worth telling the author about
  // regardless of whether this particular run could have answered.
  if (policy.noGatingScoreErrors) {
    const gate = "noGatingScoreErrors";
    if (!hasSnapshot) {
      verdicts.push({ gate, status: "non_gateable", message: noSnapshot });
    } else if (gateability === "non_gateable") {
      verdicts.push({
        gate,
        status: "non_gateable",
        message: integrityReason(input.scoreIntegrity),
      });
    } else {
      // Joined by definitionHash, like every other consumer. Matching on
      // scorerId would grade a row against whichever definition happened to
      // land last in the map when a merged run carries the same id under two
      // hashes.
      const errored = scores.filter(
        (score) =>
          score.status === "error" &&
          byHash.get(score.definitionHash)?.role === "gating"
      );
      verdicts.push({
        gate,
        status: errored.length === 0 ? "passed" : "failed",
        message:
          errored.length === 0
            ? "no gating scorer errored"
            : `${errored.length} gating score(s) errored: ` +
              `${[...new Set(errored.map((score) => score.scorerId))].join(", ")}`,
        observed: errored.length,
      });
    }
  }

  for (const [scorerId, minimum] of Object.entries(
    policy.minimumScorerPassRate ?? {}
  )) {
    const gate = `minimumScorerPassRate:${scorerId}`;
    const bad = threshold(gate, minimum);
    if (bad) {
      verdicts.push(bad);
      continue;
    }
    if (!hasSnapshot) {
      verdicts.push({
        gate,
        status: "non_gateable",
        message: noSnapshot,
        threshold: minimum,
      });
      continue;
    }
    const resolved = resolveScorer(scorerId, byId, gate);
    if (!resolved.ok) {
      verdicts.push(resolved.verdict);
      continue;
    }
    if (gateability === "non_gateable") {
      verdicts.push({
        gate,
        status: "non_gateable",
        message: integrityReason(input.scoreIntegrity),
        threshold: minimum,
      });
      continue;
    }
    const rows = countable(rowsFor(scores, scorerId));
    if (rows.length === 0) {
      verdicts.push({
        gate,
        status: "non_gateable",
        message: `no applicable "${scorerId}" scores in this run`,
        threshold: minimum,
      });
      continue;
    }
    const rate =
      rows.filter((row) => row.passed === true).length / rows.length;
    verdicts.push({
      gate,
      status: rate >= minimum ? "passed" : "failed",
      message: `${rows.filter((row) => row.passed === true).length}/${rows.length} "${scorerId}" scores passed`,
      observed: rate,
      threshold: minimum,
    });
  }

  for (const [scorerId, minimum] of Object.entries(
    policy.minimumMeanScore ?? {}
  )) {
    const gate = `minimumMeanScore:${scorerId}`;
    const bad = threshold(gate, minimum);
    if (bad) {
      verdicts.push(bad);
      continue;
    }
    if (!hasSnapshot) {
      verdicts.push({
        gate,
        status: "non_gateable",
        message: noSnapshot,
        threshold: minimum,
      });
      continue;
    }
    const resolved = resolveScorer(scorerId, byId, gate);
    if (!resolved.ok) {
      verdicts.push(resolved.verdict);
      continue;
    }
    if (gateability === "non_gateable") {
      verdicts.push({
        gate,
        status: "non_gateable",
        message: integrityReason(input.scoreIntegrity),
        threshold: minimum,
      });
      continue;
    }
    // Only `scored` rows carry a value; an errored or skipped scorer has no
    // number to average, and inventing a 0 for it would conflate "crashed"
    // with "graded badly".
    const values = rowsFor(scores, scorerId)
      .filter((row) => row.status === "scored" && row.value !== undefined)
      .map((row) => row.value as number);
    if (values.length === 0) {
      verdicts.push({
        gate,
        status: "non_gateable",
        message: `no scored "${scorerId}" values in this run`,
        threshold: minimum,
      });
      continue;
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    verdicts.push({
      gate,
      status: mean >= minimum ? "passed" : "failed",
      message: `mean "${scorerId}" score ${mean.toFixed(3)} over ${values.length} scored row(s)`,
      observed: mean,
      threshold: minimum,
    });
  }

  return {
    // Precedence: a broken policy outranks everything (nothing it says can be
    // trusted), then a real failure, then an undecidable gate. A run with both
    // a failure and a non-gateable gate DID regress, and saying "incomplete"
    // would bury that.
    outcome: verdicts.some((verdict) => verdict.status === "usage_error")
      ? "usage_error"
      : verdicts.some((verdict) => verdict.status === "failed")
        ? "failed"
        : verdicts.some((verdict) => verdict.status === "non_gateable")
          ? "incomplete"
          : "passed",
    verdicts,
    scoreIntegrity: input.scoreIntegrity ?? "unknown",
  };
}

/** Thrown by {@link assertGate}. Carries the full report, not just a message. */
export class GateError extends Error {
  readonly report: GateReport;

  constructor(report: GateReport) {
    super(formatGateReport(report));
    this.name = "GateError";
    this.report = report;
  }
}

/**
 * Evaluate and throw unless every gate passed. An `incomplete` outcome throws
 * too: a gate that could not be decided has not been satisfied.
 */
export function assertGate(input: GateInput, policy: GatePolicy): GateReport {
  const report = evaluateGates(input, policy);
  if (report.outcome !== "passed") throw new GateError(report);
  return report;
}

const STATUS_LABEL: Record<GateStatus, string> = {
  passed: "PASS",
  failed: "FAIL",
  non_gateable: "N/A ",
  usage_error: "ERR ",
};

/**
 * Map a gate's own outcome onto the `StructuredRunReport` verdict vocabulary.
 *
 * `incomplete` — a `--wait` timeout, a cancelled run, non-gateable score
 * integrity, an inconclusive backend result — is the gate's own version of
 * "not enough was measured", the exact claim `inconclusive` makes for an eval
 * run. It must map there, never to `failed`: a gate report is `passed: false`
 * whenever it isn't `passed`, so a renderer that infers the verdict from
 * `passed` alone (the way `renderStructuredRunHtml` falls back when no
 * verdict is given) paints an unmeasured gate red — a measured regression
 * the run never established. `usage_error` is a genuine gate-config defect,
 * so it reads as a failure like `failed` does.
 */
export function gateOutcomeVerdict(
  outcome: GateReport["outcome"]
): StructuredRunVerdict {
  switch (outcome) {
    case "passed":
      return "passed";
    case "incomplete":
      return "inconclusive";
    case "failed":
    case "usage_error":
      return "failed";
  }
}

export function formatGateReport(report: GateReport): string {
  const lines = [
    `Gate: ${report.outcome.toUpperCase()} (score integrity: ${report.scoreIntegrity})`,
  ];
  for (const verdict of report.verdicts) {
    const threshold =
      verdict.threshold === undefined ? "" : ` [threshold ${verdict.threshold}]`;
    lines.push(
      `  ${STATUS_LABEL[verdict.status]} ${verdict.gate}: ${verdict.message}${threshold}`
    );
  }
  return lines.join("\n");
}

/**
 * Convert a percent-shaped boundary value (a CLI flag, a legacy config field)
 * into the fraction this module works in.
 *
 * Exists so the conversion happens in exactly one place: `100` must map to `1`
 * EXACTLY, since `minimumPassRate: 1` is the common "no failures allowed" case
 * and a float that lands a hair under would let a fully-passing run fail.
 */
export function passRateFractionFromPercent(percent: number): number {
  return percent / 100;
}
