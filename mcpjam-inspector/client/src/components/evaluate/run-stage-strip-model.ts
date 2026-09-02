/**
 * The six stages as a strip: how far the run's iterations got, and where.
 *
 * A compact reading of the run-scoped stage-analytics document, sitting between
 * the verdict and the case rows. It answers "how much of this run was actually
 * measured" — the follow-up question, after "what broke" — and doubles as a
 * filter over the rows beneath it.
 *
 * ── What it is careful not to become ─────────────────────────────────────────
 *
 * A funnel is a POPULATION statistic and a chain is one iteration's journey.
 * Confusing the two is what made the old suite-level funnel unreadable: six
 * green stages over "2 of 3 trials", where the excluded one was precisely the
 * trial that broke. So this strip is run-scoped by construction — the document
 * is one per run and there is no merge — and every cell says which population
 * it counted.
 *
 * Rates come only from the contract's helpers, so a zero denominator is the
 * words "not measured" and never `0%`. Nothing here divides.
 */
import {
  USER_VALUE_STAGES,
  USER_VALUE_STAGE_LABELS,
  measuredPassRate,
  reachRate,
  type EvalStageAnalyticsV1,
  type UserValueStage,
} from "@mcpjam/sdk/contract";

import { NOT_MEASURED_LABEL, overallSlice } from "./stage-analytics-model";

export type StageStripCell = {
  stage: UserValueStage;
  label: string;
  /** "12 of 16 measured" or the words "not measured". Never a bare percent. */
  measured: string;
  /** "4 not reached", when any were. */
  notReached: string | null;
  tone: "measured" | "attention" | "unmeasured";
};

export type StageStripView =
  /** Nothing was asked for, so nothing is claimed. */
  | { kind: "hidden" }
  | { kind: "loading" }
  /**
   * This run has no stage measurements, said out loud.
   *
   * Documents are materialized at terminalization and never backfilled, so a
   * run that finished before that shipped genuinely has none. The section stays
   * on the page and says so: a strip that silently vanished left a reader
   * unable to tell "not measured" from "the page is broken", which is the
   * confusion this state exists to end.
   */
  | { kind: "notMeasured"; message: string }
  /** The read failed. Distinct from "this run was not measured". */
  | { kind: "unavailable"; message: string }
  | {
      kind: "ready";
      cells: StageStripCell[];
      /** True while a judge fanout could still move these numbers. */
      provisional: boolean;
      /** Trials the document counted, so a reader knows the population. */
      trials: number;
    };

export type BuildStageStripInput = {
  status: "idle" | "loading" | "ready" | "absent" | "error";
  document: EvalStageAnalyticsV1 | null;
  /**
   * WHICH failure, when there was one.
   *
   * The adapter keeps four kinds apart and the first draft of this strip threw
   * all of them away, printing one sentence for a permission problem, a
   * deployment without the route, a contract violation and a network blip
   * alike. That sentence sent two people looking in the wrong place, so the
   * kinds travel through to the reader now.
   */
  error?: { kind: string; status?: number } | null;
};

const FAILURE_MESSAGE: Record<string, string> = {
  routeUnavailable:
    "This deployment does not serve stage measurements, so how far this run's iterations got is not established.",
  invalidContract:
    "This run's stage measurements did not match the published contract, so they are withheld rather than shown unchecked.",
  requestFailed:
    "Stage measurements could not be read for this run. The request did not complete.",
};

export function buildStageStrip(input: BuildStageStripInput): StageStripView {
  // `idle` means the read was never made — no project id, or a run that is not
  // terminal. Nothing was asked, so nothing is said.
  if (input.status === "idle") return { kind: "hidden" };
  if (input.status === "loading") return { kind: "loading" };

  // `absent` is a 404: this run predates the materializer or never had a
  // document. Still not a funnel of zeros — but not a disappearing section
  // either, because a reader cannot tell a hidden strip from a broken page.
  if (input.status === "absent") {
    return {
      kind: "notMeasured",
      message:
        "Stage measurements were not recorded for this run, so how far its iterations got is not established.",
    };
  }

  if (input.status === "error" || !input.document) {
    const kind = input.error?.kind ?? "requestFailed";
    const base = FAILURE_MESSAGE[kind] ?? FAILURE_MESSAGE.requestFailed;
    // The status code is the one thing that turns "could not be read" into
    // something a reader can act on: 401 is a permission, 500 is ours.
    const suffix =
      typeof input.error?.status === "number" ? ` (HTTP ${input.error.status})` : "";
    return { kind: "unavailable", message: `${base}${suffix}` };
  }

  const overall = overallSlice(input.document);
  if (!overall) {
    return {
      kind: "notMeasured",
      message:
        "This run's stage document carries no overall slice, so nothing is counted here.",
    };
  }

  const talliesByStage = new Map(
    overall.stages.map((tally) => [tally.stage, tally]),
  );

  const cells = USER_VALUE_STAGES.map((stage): StageStripCell => {
    const label = USER_VALUE_STAGE_LABELS[stage];
    const tally = talliesByStage.get(stage);
    if (!tally) {
      return {
        stage,
        label,
        measured: NOT_MEASURED_LABEL,
        notReached: null,
        tone: "unmeasured",
      };
    }

    // Both rates come from the contract's own helpers. A zero denominator is
    // `notMeasured` there, which is why nothing in this file divides.
    const pass = measuredPassRate(tally);
    const reach = reachRate(tally);

    if (pass.state === "notMeasured") {
      return {
        stage,
        label,
        measured: NOT_MEASURED_LABEL,
        notReached: null,
        tone: "unmeasured",
      };
    }

    const failed = pass.denominator - pass.numerator;
    const unreached =
      reach.state === "notMeasured" ? 0 : reach.denominator - reach.numerator;

    return {
      stage,
      label,
      measured: `${pass.numerator} of ${pass.denominator} measured`,
      notReached: unreached > 0 ? `${unreached} not reached` : null,
      tone: failed > 0 ? "attention" : "measured",
    };
  });

  return {
    kind: "ready",
    cells,
    provisional: input.document.materializationState === "provisional",
    trials: overall.includedTrials,
  };
}
