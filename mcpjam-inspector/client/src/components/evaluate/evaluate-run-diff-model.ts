/**
 * What changed since the previous run, per case and for the run as a whole.
 *
 * The page's original problem was that it led with a pass rate and never said
 * whether that rate had moved. A reader could not tell one regressing case from
 * a run that had always been at 67%. These are the two answers to that: a
 * counted line for the run, and a pill per row.
 *
 * ── The one rule that keeps this honest ──────────────────────────────────────
 *
 * The diff's own `status` is authoritative and this file adds no adjective of
 * its own. It computes no interval, no significance and no "worse", because a
 * pass-rate move at ten iterations is mostly noise and a UI that called every
 * such move a regression would make the column worthless within a week. Where
 * both runs' fractions are known they are BOTH shown, side by side, with no
 * verb between them — the reader gets the numbers and the diff's own word for
 * what happened, and nothing that was not measured.
 *
 * A loading or failed comparison produces NO pill. Never "Unchanged": that is a
 * claim about a comparison, and a comparison that did not happen supports no
 * claim at all.
 */
import type {
  EvalRunCompareCaseStatus,
  EvalRunCompareDto,
} from "@/lib/apis/eval-run-compare-api";

import type { EvaluateCaseRow } from "./evaluate-case-row-model";

export type RunChangeSummary = {
  regressed: number;
  fixed: number;
  stillFailing: number;
  passing: number;
  added: number;
  removed: number;
  changed: number;
  baseRunNumber: number;
};

export function summarizeRunChanges(dto: EvalRunCompareDto): RunChangeSummary {
  const summary: RunChangeSummary = {
    regressed: 0,
    fixed: 0,
    stillFailing: 0,
    passing: 0,
    added: 0,
    removed: 0,
    changed: 0,
    baseRunNumber: dto.baseRun.runNumber,
  };
  for (const entry of dto.cases) {
    switch (entry.status) {
      case "regressed":
        summary.regressed += 1;
        break;
      case "fixed":
        summary.fixed += 1;
        break;
      case "unchanged_failed":
        summary.stillFailing += 1;
        break;
      case "unchanged_passed":
        summary.passing += 1;
        break;
      case "new_case":
        summary.added += 1;
        break;
      case "removed_case":
        summary.removed += 1;
        break;
      case "changed":
        summary.changed += 1;
        break;
    }
  }
  return summary;
}

/** The counted line under the verdict, as parts a view can lay out. */
export function describeRunChanges(summary: RunChangeSummary): string[] {
  const parts: string[] = [];
  const push = (count: number, label: string) => {
    if (count > 0) parts.push(`${count} ${label}`);
  };
  push(summary.regressed, "regressed");
  push(summary.fixed, "fixed");
  push(summary.stillFailing, "still failing");
  push(summary.passing, "passing");
  push(summary.added, "new");
  push(summary.removed, "removed");
  push(summary.changed, "reconfigured");
  return parts;
}

export type RunChangePillKind =
  | "regressed"
  | "fixed"
  | "stillFailing"
  | "unchanged"
  | "added"
  | "reconfigured";

export const RUN_CHANGE_PILL_LABELS: Record<RunChangePillKind, string> = {
  regressed: "Regressed",
  fixed: "Fixed",
  stillFailing: "Still failing",
  unchanged: "Unchanged",
  added: "New",
  reconfigured: "Reconfigured",
};

export type RunChangePill = {
  kind: RunChangePillKind;
  label: string;
  /** "6/10, was 7/10" — plain fractions, no adjective. Null when unknowable. */
  detail: string | null;
};

/**
 * The pill for one row, or nothing.
 *
 * Nothing in three cases: the comparison did not happen, the case is not in it,
 * or the case was REMOVED (in which case there is no row on this page to
 * decorate — a removed case has no compare side).
 */
export function derivePillForCase(input: {
  status: EvalRunCompareCaseStatus;
  thisRun: { passed: number; total: number } | null;
  previousRun: { passed: number; total: number } | null;
  configChanged: boolean;
}): RunChangePill | null {
  if (input.status === "removed_case") return null;

  const kind: RunChangePillKind =
    input.status === "regressed"
      ? "regressed"
      : input.status === "fixed"
        ? "fixed"
        : input.status === "unchanged_failed"
          ? "stillFailing"
          : input.status === "unchanged_passed"
            ? "unchanged"
            : input.status === "new_case"
              ? "added"
              : "reconfigured";

  if (kind === "reconfigured") {
    // Fractions across a config change compare two different tests, so they
    // are withheld rather than shown as a trend.
    return {
      kind,
      label: RUN_CHANGE_PILL_LABELS[kind],
      detail: input.configChanged
        ? "config differs from the previous run"
        : "the case changed between runs",
    };
  }

  if (kind === "added") {
    return {
      kind,
      label: RUN_CHANGE_PILL_LABELS[kind],
      detail: "not in the previous run",
    };
  }

  const now = input.thisRun;
  const before = input.previousRun;
  if (!now) return { kind, label: RUN_CHANGE_PILL_LABELS[kind], detail: null };

  if (now.total === 1 && (!before || before.total === 1)) {
    // One observation either side. Saying "1/1, was 1/1" invites reading it as
    // a stable result; it is two single observations.
    return {
      kind,
      label: RUN_CHANGE_PILL_LABELS[kind],
      detail: "single iteration",
    };
  }

  if (!before) {
    return {
      kind,
      label: RUN_CHANGE_PILL_LABELS[kind],
      detail: `${now.passed}/${now.total}`,
    };
  }

  // Both fractions, no verb. The diff's own word is the only adjective on the
  // row, and it is already in the label.
  return {
    kind,
    label: RUN_CHANGE_PILL_LABELS[kind],
    detail: `${now.passed}/${now.total}, was ${before.passed}/${before.total}`,
  };
}

/**
 * Attach a pill to each row.
 *
 * Joined on `caseKey` — the same key the diff groups by, and the one identity
 * that is stable across two runs of the same suite. A row whose key is not in
 * the comparison gets no pill, because the honest answer is that this run's
 * comparison says nothing about it.
 */
export function pillsByRowKey(input: {
  rows: readonly EvaluateCaseRow[];
  dto: EvalRunCompareDto | null;
  caseKeyOf: (row: EvaluateCaseRow) => string | null;
  previousIterationsOf: (
    caseKey: string,
  ) => { passed: number; total: number } | null;
}): Map<string, RunChangePill> {
  const pills = new Map<string, RunChangePill>();
  if (!input.dto) return pills;

  const byCaseKey = new Map(
    input.dto.cases.map((entry) => [entry.caseKey, entry]),
  );
  for (const row of input.rows) {
    const caseKey = input.caseKeyOf(row);
    if (!caseKey) continue;
    const entry = byCaseKey.get(caseKey);
    if (!entry) continue;
    const pill = derivePillForCase({
      status: entry.status,
      thisRun: row.iterations,
      previousRun: input.previousIterationsOf(caseKey),
      configChanged: Boolean(
        entry.configChanged || entry.evaluationConfigChanged,
      ),
    });
    if (pill) pills.set(row.key, pill);
  }
  return pills;
}
