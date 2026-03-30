/**
 * Single-sentence status lines for Auto fix (trace repair job UI).
 */

export type AutoFixJobViewSnapshot = {
  jobId: string;
  status: string;
  phase: string;
  scope: "suite" | "case";
  currentCaseKey?: string | null;
  activeCaseKeys?: string[];
  attemptLimit?: number;
  provisionalAppliedCount?: number;
  durableFixCount?: number;
  regressedCount?: number;
  serverLikelyCount?: number;
  exhaustedCount?: number;
  promisingCount?: number;
  accuracyBefore?: number | null;
  accuracyAfter?: number | null;
};

export type AutoFixOutcomeSnapshot = AutoFixJobViewSnapshot & {
  stopReason?: string;
  lastError?: string;
  completedAt?: number;
  updatedAt?: number;
};

function formatPassRateForSentence(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) {
    return "—";
  }
  const pct = v <= 1 ? Math.round(v * 100) : Math.round(v);
  return `${pct}%`;
}

function truncateDetail(s: string, max = 140): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max - 1)}…`;
}

function phaseClause(phase: string, scope: "suite" | "case"): string {
  const target = scope === "case" ? "this case" : "the suite";
  switch (phase) {
    case "preparing":
      return `is preparing the next steps for ${target}`;
    case "repairing":
      return `is generating and verifying repairs for ${target}`;
    case "replaying":
      return `is replaying ${target} to verify fixes`;
    case "finalizing":
      return `is finishing up for ${target}`;
    default:
      return `is running (${phase})`;
  }
}

export function activeAutoFixSentence(
  view: AutoFixJobViewSnapshot,
  scope: "suite" | "case",
  caseTitleByKey: Record<string, string>,
): string {
  const clause = phaseClause(view.phase, scope);
  const key = view.currentCaseKey;
  const title = key != null && key !== "" ? (caseTitleByKey[key] ?? key) : null;
  const p = view.provisionalAppliedCount ?? 0;
  const inflight = view.promisingCount ?? 0;

  let s = `Auto fix ${clause}`;
  if (title) {
    s += `, currently on “${title}”`;
  }
  if (p > 0) {
    s += `, with ${p} provisional change${p === 1 ? "" : "s"} applied so far`;
  }
  if (inflight > 0) {
    s += ` and ${inflight} case${inflight === 1 ? "" : "s"} still in flight`;
  }
  s += ".";
  return s;
}

function suiteStopReasonCore(
  reason: string,
  o: AutoFixOutcomeSnapshot,
): string {
  const prov = o.provisionalAppliedCount ?? 0;
  const before = formatPassRateForSentence(o.accuracyBefore);
  const after = formatPassRateForSentence(o.accuracyAfter);

  switch (reason) {
    case "completed_replayed":
      return `Auto fix finished after replaying the suite, with pass rate moving from ${before} to ${after}.`;
    case "completed_server_likely":
      return "Auto fix stopped because repeated failures matched the same signature, which often indicates a server-side issue rather than the eval definition.";
    case "stopped_nothing_to_repair":
      return "Auto fix had nothing to change because there were no failing cases to work from on this run.";
    case "stopped_generation_error":
      return "Auto fix could not produce a usable repair candidate, so verification and replay never started.";
    case "stopped_no_progress":
      return prov > 0
        ? `Auto fix stopped without enough verified progress to promote changes or replay the suite after ${prov} provisional change${prov === 1 ? "" : "s"}.`
        : "Auto fix stopped without enough verified progress to promote changes or replay the suite.";
    case "cancelled_by_user":
      return "Auto fix was cancelled.";
    case "cancelled_due_to_suite_change":
      return "Auto fix stopped because the suite changed while it was running.";
    case "worker_error":
      return "Auto fix ended unexpectedly due to an internal error.";
    default:
      return `Auto fix finished (${reason || "unknown"}).`;
  }
}

function caseStopReasonCore(reason: string, o: AutoFixOutcomeSnapshot): string {
  const prov = o.provisionalAppliedCount ?? 0;
  const sl = o.serverLikelyCount ?? 0;

  switch (reason) {
    case "completed_case":
      return prov > 0
        ? "Auto fix produced a provisional change for this case; no full suite replay was run, so treat the result as tentative."
        : "Auto fix finished this case without a provisional promotion.";
    case "completed_server_likely":
      return "Auto fix suggests a likely server issue after repeated failures shared the same signature.";
    case "stopped_nothing_to_repair":
      return "Auto fix had nothing to change because there were no failing cases to work from on this run.";
    case "stopped_generation_error":
      return "Auto fix could not produce a usable repair candidate, so verification never started.";
    case "stopped_no_progress":
      return "Auto fix could not confirm enough verified progress to lock in a repair or a likely server fault for this case.";
    case "cancelled_by_user":
      return "Auto fix was cancelled.";
    case "cancelled_due_to_suite_change":
      return "Auto fix stopped because the suite changed while it was running.";
    case "worker_error":
      return "Auto fix ended unexpectedly due to an internal error.";
    default:
      if (reason === "completed_replayed") {
        return suiteStopReasonCore(reason, o);
      }
      return `Auto fix finished (${reason || "unknown"}).`;
  }
}

export function terminalAutoFixSentence(
  outcome: AutoFixOutcomeSnapshot,
  scope: "suite" | "case",
): string {
  const reason = outcome.stopReason ?? "";
  let core =
    scope === "suite"
      ? suiteStopReasonCore(reason, outcome)
      : caseStopReasonCore(reason, outcome);

  if (outcome.lastError && outcome.lastError.trim() !== "") {
    core += ` — ${truncateDetail(outcome.lastError)}`;
  }
  return core;
}
