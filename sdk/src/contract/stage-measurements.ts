/**
 * `StageMeasurementsV1` — how LONG each stage took, and whether it was reached
 * at all, for one trial.
 *
 * This module is browser-safe and intentionally has no node-only deps. Like
 * `./stage-derivation.ts` it is PURE: no ctx, no network, no clock. Same input,
 * same rows, forever.
 *
 * ── Why this is a separate contract from the decision ────────────────────────
 *
 * `StageResultRow` says whether a stage PASSED. This says how long it took and
 * whether it was reached. They are deliberately different objects, and timing
 * is deliberately NOT a field on `StageResultRow`, for one reason: the decision
 * contract is what gates a run, and every field added to it is a field a gate
 * might come to depend on. No verdict may ever be derived from a duration. A
 * slow server is not a failing server, and the moment latency shares a row with
 * a state, somebody writes `row.latency > x ⇒ failed` and the two contracts
 * have merged.
 *
 * So: the decision contract is unchanged by this file, and analytics reads
 * both.
 *
 * ── Why it is produced where it is ───────────────────────────────────────────
 *
 * Beside stage metadata in `finalize-iteration.ts`, while the full trace spans
 * are still in memory (B5c wires that; B5a freezes the shape). That placement
 * is the entire design:
 *
 *   - Trace blobs are large and archived. An analytics path that re-reads them
 *     later is a path that gets slower every week and that stops working the
 *     moment retention deletes the blob — at which point the timing is gone,
 *     not stale.
 *   - The same pure helper here also runs during the judge's second pass, so a
 *     rebuilt attribution produces measurements identical to the first pass.
 *     Hosted and SDK runs go through the same function for the same reason.
 *
 * ── Reach is not a sixth stage state ─────────────────────────────────────────
 *
 * {@link STAGE_REACH_STATES} is a PROJECTION of the five stage states onto the
 * one question analytics asks of a funnel — "did the trial get here?" — not a
 * new vocabulary. {@link reachForStageState} is the only mapping, and the
 * interesting case is `notMeasured ⇒ unknown`: a stage we captured nothing for
 * might have been reached and might not, and answering "notReached" would put
 * a trial we know nothing about into the denominator of a reach rate as a
 * confirmed drop-off. Unknown reach is an EXCLUSION, never an observation.
 */

import { z } from "zod";
import {
  USER_VALUE_STAGES,
  userValueStageSchema,
  type StageState,
  type UserValueStage,
} from "./chain.js";
import {
  STAGE_ANALYZER_VERSION,
  type StageResultRow,
} from "./stage-derivation.js";

/**
 * Bump when the MEASUREMENT shape or its semantics change.
 *
 * Independent of `STAGE_ANALYZER_VERSION`: the derivation semantics and the
 * timing semantics move for different reasons, and a consumer needs to know
 * which one it is behind. Both travel on every payload.
 */
export const STAGE_MEASUREMENTS_SCHEMA_VERSION = 1;
export type StageMeasurementsSchemaVersion =
  typeof STAGE_MEASUREMENTS_SCHEMA_VERSION;

/** The only latency unit this contract admits. Milliseconds, always. */
export const LATENCY_UNIT = "ms" as const;

/**
 * How a per-trial stage latency was computed.
 *
 * A literal on every sample rather than a convention, because a number labelled
 * only "ms" cannot be compared safely against another number labelled only
 * "ms". `evidence_span_union` means: the union of the COMPLETE intervals of the
 * spans this stage's row actually cited as evidence. Not wall time, not a sum
 * of durations, not a first-to-last envelope.
 */
export const LATENCY_BASIS_EVIDENCE_SPAN_UNION = "evidence_span_union" as const;

/**
 * How a SETUP latency was computed: the phase's wall-clock envelope.
 *
 * A different basis from the per-trial one and it must never be mixed into the
 * same aggregate. A setup phase is measured once per run; a stage is measured
 * once per trial. Averaging the two produces a number that is not the mean of
 * anything.
 */
export const LATENCY_BASIS_SETUP_PHASE_WALL = "setup_phase_wall" as const;

/**
 * Did the trial get to this stage?
 *
 *   - `reached`       — it ran here. Passed or failed, it ran.
 *   - `notReached`    — an earlier stage failed, so it never ran.
 *   - `unknown`       — nothing was captured, so we cannot say. EXCLUDED from
 *     reach denominators; never counted as a drop-off.
 *   - `notApplicable` — the stage does not apply to this case at all.
 */
export const STAGE_REACH_STATES = [
  "reached",
  "notReached",
  "unknown",
  "notApplicable",
] as const;
export type StageReach = (typeof STAGE_REACH_STATES)[number];
export const stageReachSchema = z.enum(STAGE_REACH_STATES);

/**
 * The reach a stage's decided state IMPLIES on its own, with no other evidence.
 *
 * `failed ⇒ reached` is the case worth stating: a stage that produced a failure
 * verdict demonstrably ran. Excluding failures from `reached` would make a
 * funnel narrow exactly where things went wrong, which is the one place it must
 * not.
 *
 * `notMeasured ⇒ unknown` is the DEFAULT, not a fact — and this is the one
 * place reach is genuinely richer than state. "We captured nothing that could
 * decide this stage" and "this stage never ran" are different claims, and a
 * `notMeasured` row that nevertheless cites spans (a pending judge, say) is
 * positive evidence the stage DID run. {@link deriveStageMeasurements} upgrades
 * those to `reached`; {@link reachIsConsistentWithState} is what permits it.
 *
 * That upgrade is what makes measurement coverage a real number. If reach were
 * a pure function of state, `reached` would equal `passed + failed` by
 * construction, `measured / reached` would be 1 in every run ever recorded, and
 * the metric that exists to expose under-instrumentation would be the one
 * metric incapable of reporting it.
 */
export function reachForStageState(state: StageState): StageReach {
  switch (state) {
    case "passed":
    case "failed":
      return "reached";
    case "notReached":
      return "notReached";
    case "notApplicable":
      return "notApplicable";
    case "notMeasured":
      return "unknown";
  }
}

/**
 * May a stage in this state report this reach?
 *
 * Every state pins its reach exactly, EXCEPT `notMeasured`, which admits both
 * `unknown` (nothing captured) and `reached` (something was captured, it just
 * did not decide the stage). Both write boundaries check this rather than
 * equality against {@link reachForStageState}, because equality would reject
 * the upgrade the previous docblock exists to allow.
 */
export function reachIsConsistentWithState(
  state: StageState,
  reach: StageReach
): boolean {
  if (state === "notMeasured") {
    return reach === "unknown" || reach === "reached";
  }
  return reach === reachForStageState(state);
}

/**
 * The stages that may carry a per-trial latency at schema version 1.
 *
 * - `selection` — from the referenced prompt/LLM spans.
 * - `call` / `response` — from the referenced tool spans. These two MAY report
 *   the same number: one tool round trip is honestly evidence for both, and
 *   inventing a split would be fabricating a boundary the spans do not record.
 *
 * Excluded, each for its own reason:
 *
 * - `connection` / `discovery` — their timing is a SETUP PHASE fact, measured
 *   once per run and copied onto every iteration for derivation. Emitting it
 *   per trial would multiply one 3-second connect by the trial count and report
 *   it as per-trial latency. It is aggregated separately, once, under
 *   {@link LATENCY_BASIS_SETUP_PHASE_WALL}.
 * - `userValue` — there is no grader timer yet. When one exists it is an
 *   explicit, named timer and a version bump, not a reuse of whatever interval
 *   happens to be nearby.
 */
export const STAGE_LATENCY_ELIGIBLE_STAGES = [
  "selection",
  "call",
  "response",
] as const satisfies readonly UserValueStage[];

export function stageMayCarryLatency(stage: UserValueStage): boolean {
  return (STAGE_LATENCY_ELIGIBLE_STAGES as readonly string[]).includes(stage);
}

/** One stage's latency sample. */
export const stageLatencySampleSchema = z
  .object({
    unit: z.literal(LATENCY_UNIT),
    basis: z.literal(LATENCY_BASIS_EVIDENCE_SPAN_UNION),
    /**
     * Finite and nonnegative. `0` is a legal MEASURED value (a cached round
     * trip inside timer resolution); it is not, and must never be produced as,
     * a stand-in for "no sample". Absence is spelled by omitting the field.
     */
    value: z.number().finite().min(0),
  })
  .strict();
export type StageLatencySample = z.infer<typeof stageLatencySampleSchema>;

/** One stage's measurement for one trial. */
export const stageMeasurementRowSchema = z
  .object({
    stage: userValueStageSchema,
    reach: stageReachSchema,
    latency: stageLatencySampleSchema.optional(),
  })
  .strict();
export type StageMeasurementRow = z.infer<typeof stageMeasurementRowSchema>;

/** The full measurement payload for one trial. */
export type StageMeasurementsV1 = {
  schemaVersion: StageMeasurementsSchemaVersion;
  stageAnalyzerVersion: number;
  /** ALWAYS six rows, in `USER_VALUE_STAGES` order. Never sorted. */
  rows: StageMeasurementRow[];
};

export const stageMeasurementsStructuralSchema = z
  .object({
    schemaVersion: z.literal(STAGE_MEASUREMENTS_SCHEMA_VERSION),
    /**
     * The derivation version the rows were measured ALONGSIDE.
     *
     * Carried here as well as on the derivation so an aggregator holding only
     * measurements can still tell a v3 chain from a v4 one. A mismatch against
     * the chain it ships with is an integrity failure, not a rounding detail:
     * the two describe the same six stages and cannot have been produced by
     * different analyzers.
     */
    stageAnalyzerVersion: z.number().int().min(1),
    rows: z.array(stageMeasurementRowSchema).length(USER_VALUE_STAGES.length),
  })
  .strict();

/**
 * The measurement validator, with the invariants the structural half cannot
 * express.
 *
 * Row ORDER is checked, not just row membership. The six stages are a funnel
 * and position is meaning — an aggregator that zips these rows against
 * `USER_VALUE_STAGES` positionally (every one of them does) reads a reordered
 * payload as a completely different set of observations, silently.
 */
export const stageMeasurementsSchema =
  stageMeasurementsStructuralSchema.superRefine((measurements, ctx) => {
    USER_VALUE_STAGES.forEach((stage, index) => {
      const row = measurements.rows[index];
      if (row === undefined) return;
      if (row.stage !== stage) {
        ctx.addIssue({
          code: "custom",
          path: ["rows", index, "stage"],
          message:
            `rows[${index}] is '${row.stage}' but must be '${stage}': the six ` +
            `rows are a funnel in USER_VALUE_STAGES order and position is meaning`,
        });
      }
      if (row.latency !== undefined && !stageMayCarryLatency(row.stage)) {
        ctx.addIssue({
          code: "custom",
          path: ["rows", index, "latency"],
          message:
            `stage '${row.stage}' may not carry a per-trial latency at schema ` +
            `version ${STAGE_MEASUREMENTS_SCHEMA_VERSION} (eligible stages: ` +
            `${STAGE_LATENCY_ELIGIBLE_STAGES.join(", ")})`,
        });
      }
      if (row.latency !== undefined && row.reach !== "reached") {
        ctx.addIssue({
          code: "custom",
          path: ["rows", index, "latency"],
          message:
            `stage '${row.stage}' reports latency but reach is '${row.reach}': ` +
            `a stage that was not reached cannot have taken time`,
        });
      }
    });
  });

/**
 * Do these measurements describe the SAME six stages as this derivation?
 *
 * Returns the disagreements rather than a boolean so a write boundary can say
 * WHICH stage disagreed. Empty result means agreement.
 *
 * This is the check that keeps the two contracts joined. They are produced
 * together from one iteration and shipped as two fields; nothing but this
 * function notices if a caller pairs last run's measurements with this run's
 * chain.
 */
export function stageMeasurementDisagreements(
  measurements: Pick<StageMeasurementsV1, "rows" | "stageAnalyzerVersion">,
  stageResults: readonly StageResultRow[],
  stageAnalyzerVersion: number
): string[] {
  const problems: string[] = [];
  if (measurements.stageAnalyzerVersion !== stageAnalyzerVersion) {
    problems.push(
      `stageAnalyzerVersion ${measurements.stageAnalyzerVersion} does not ` +
        `match the chain's ${stageAnalyzerVersion}`
    );
  }
  USER_VALUE_STAGES.forEach((stage, index) => {
    const row = measurements.rows[index];
    const decided = stageResults[index];
    if (row === undefined || decided === undefined) {
      problems.push(`stage '${stage}' is missing from one of the two payloads`);
      return;
    }
    if (row.stage !== stage || decided.stage !== stage) {
      problems.push(`stage '${stage}' is out of order`);
      return;
    }
    if (!reachIsConsistentWithState(decided.state, row.reach)) {
      problems.push(
        `stage '${stage}' reports reach '${row.reach}', which state ` +
          `'${decided.state}' does not admit`
      );
    }
  });
  return problems;
}

// ── deriving the measurements ────────────────────────────────────────────────

/**
 * A span, as this module needs it: an identity and an interval.
 *
 * Deliberately structural and deliberately NOT `StageSpanLike`, which carries
 * no timestamps. Callers pass whatever their span objects are.
 */
export type MeasurementSpanLike = {
  id?: string;
  /** Epoch milliseconds. */
  startedAt?: number | null;
  /** Epoch milliseconds. */
  endedAt?: number | null;
  /** Trace wire aliases used by SDK and Inspector spans. */
  startMs?: number | null;
  endMs?: number | null;
};

export type StageMeasurementInput = {
  /** The six decided rows, in canonical order — `deriveStageResults` output. */
  stageResults: readonly StageResultRow[];
  /** The analyzer version those rows were derived at. */
  stageAnalyzerVersion?: number;
  /** Every span the iteration captured. Looked up by the rows' evidence ids. */
  spans?: readonly MeasurementSpanLike[];
};

/** One closed interval, in epoch milliseconds. */
type Interval = { start: number; end: number };

/**
 * A span's interval, or `undefined` when it does not have a complete one.
 *
 * Every rejection here means NO SAMPLE, never a zero. That is the rule the
 * whole latency story rests on: a stage whose spans lack timestamps has
 * unmeasured latency, and reporting `0` for it would drag every mean toward
 * zero in exactly the runs where instrumentation is worst.
 *
 * `end === start` is kept — a sub-millisecond span is a real observation.
 * `end < start` is dropped: a negative duration is a clock fault, and clamping
 * it to zero would launder that fault into a sample.
 */
function intervalOf(span: MeasurementSpanLike): Interval | undefined {
  const start = span.startedAt ?? span.startMs;
  const end = span.endedAt ?? span.endMs;
  if (typeof start !== "number" || !Number.isFinite(start)) return undefined;
  if (typeof end !== "number" || !Number.isFinite(end)) return undefined;
  if (end < start) return undefined;
  return { start, end };
}

/**
 * Total time covered by these intervals, counting overlap ONCE.
 *
 * Union, not sum. Two tool calls that ran concurrently for 500ms each took
 * 500ms of wall time, not 1000ms, and a "sum of span durations" latency reports
 * a server as twice as slow as it is precisely when it is doing well
 * (parallelism). Exported for the tests that pin this, and for the backend's
 * mirror to be checked against.
 */
export function unionDurationMs(intervals: readonly Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let current: Interval | undefined;
  for (const next of sorted) {
    if (current === undefined) {
      current = { start: next.start, end: next.end };
      continue;
    }
    if (next.start <= current.end) {
      // Overlapping or adjacent — extend, never add.
      if (next.end > current.end) current.end = next.end;
      continue;
    }
    total += current.end - current.start;
    current = { start: next.start, end: next.end };
  }
  return current === undefined ? 0 : total + (current.end - current.start);
}

/**
 * Produce one trial's measurements from its decided rows and its spans.
 *
 * PURE and total: it never throws, and for any input it returns exactly six
 * rows in canonical order. A stage with no usable evidence simply carries no
 * latency.
 *
 * The spans consulted for a stage are the ones that stage's OWN row cited as
 * evidence. Nothing here re-classifies spans by category or guesses which span
 * "belongs to" a stage — the derivation already decided that, and a second,
 * differently-implemented opinion about it is how the funnel and the timings
 * start describing different runs.
 */
export function deriveStageMeasurements(
  input: StageMeasurementInput
): StageMeasurementsV1 {
  const byId = new Map<string, MeasurementSpanLike>();
  for (const span of input.spans ?? []) {
    if (typeof span.id === "string" && span.id.length > 0) {
      byId.set(span.id, span);
    }
  }

  const decidedByStage = new Map<UserValueStage, StageResultRow>();
  for (const row of input.stageResults) decidedByStage.set(row.stage, row);

  const rows = USER_VALUE_STAGES.map((stage): StageMeasurementRow => {
    const decided = decidedByStage.get(stage);
    // A stage the derivation did not decide at all is UNKNOWN — not reached and
    // not dropped, the same rule `notMeasured` gets and for the same reason.
    let reach: StageReach =
      decided === undefined ? "unknown" : reachForStageState(decided.state);

    // Spans this stage's OWN row cited, that we can actually resolve. Nothing
    // here re-classifies spans by category or guesses which span "belongs to" a
    // stage: the derivation already decided that, and a second, differently
    // implemented opinion about it is how the funnel and the timings start
    // describing different runs.
    const citedSpans = (decided?.evidence?.spanIds ?? [])
      .map((spanId) => byId.get(spanId))
      .filter((span): span is MeasurementSpanLike => span !== undefined);

    // The `notMeasured` upgrade: cited, resolvable evidence proves the stage
    // ran even though nothing decided it. This is the gap measurement coverage
    // is built to expose — see `reachForStageState`.
    if (reach === "unknown" && citedSpans.length > 0) reach = "reached";

    if (reach !== "reached" || !stageMayCarryLatency(stage)) {
      return { stage, reach };
    }
    const intervals: Interval[] = [];
    for (const span of citedSpans) {
      const interval = intervalOf(span);
      if (interval !== undefined) intervals.push(interval);
    }
    if (intervals.length === 0) return { stage, reach };
    return {
      stage,
      reach,
      latency: {
        unit: LATENCY_UNIT,
        basis: LATENCY_BASIS_EVIDENCE_SPAN_UNION,
        value: unionDurationMs(intervals),
      },
    };
  });

  return {
    schemaVersion: STAGE_MEASUREMENTS_SCHEMA_VERSION,
    stageAnalyzerVersion: input.stageAnalyzerVersion ?? STAGE_ANALYZER_VERSION,
    rows,
  };
}

/**
 * The metadata key `StageMeasurementsV1` persists under, beside the chain's
 * `STAGE_METADATA_KEYS`.
 *
 * Server-owned at both write boundaries, exactly like the chain's integrity
 * keys: a caller may POST measurements, but it may not post the verdict on
 * whether they were believed.
 */
export const STAGE_MEASUREMENTS_METADATA_KEY = "stageMeasurements" as const;

/**
 * Attach derived measurements to an iteration metadata record.
 *
 * This is intentionally a no-op when no stage derivation was produced. That
 * keeps setup-only/legacy metadata unchanged while ensuring every producer that
 * has stage rows derives timing from the same in-memory spans.
 */
export function attachStageMeasurements(
  metadata: Record<string, unknown>,
  spans?: readonly MeasurementSpanLike[]
): Record<string, unknown> {
  const stageResults = metadata.stageResults;
  if (!Array.isArray(stageResults) || stageResults.length === 0) return metadata;

  const stageAnalyzerVersion =
    typeof metadata.stageAnalyzerVersion === "number" &&
    Number.isInteger(metadata.stageAnalyzerVersion) &&
    metadata.stageAnalyzerVersion >= 1
      ? metadata.stageAnalyzerVersion
      : undefined;

  const stageMeasurements = deriveStageMeasurements({
    stageResults: stageResults as readonly StageResultRow[],
    ...(stageAnalyzerVersion !== undefined ? { stageAnalyzerVersion } : {}),
    spans,
  });
  return {
    ...metadata,
    [STAGE_MEASUREMENTS_METADATA_KEY]: stageMeasurements,
  };
}
