/**
 * group-case-iterations — fold a flat list of a case's iterations into the
 * "run batches" that produced them, the unit users actually reason about.
 *
 * Grouping key: `suiteRunId` for suite runs; for inline "quick" runs (no
 * suiteRunId) the client tags every iteration of one Run click with
 * `metadata.compareRunId` (see compare-playground-helpers). Iterations with
 * neither stand alone (legacy / one-off) keyed by their own id.
 *
 * Batches are newest-first (by latest iteration createdAt); iterations within a
 * batch are ordered by `iterationNumber` (falling back to createdAt).
 */
import { formatRunId } from "../helpers";
import type { EvalIteration } from "../types";

export interface CaseRunBatch {
  /** Stable grouping key (suiteRunId | compareRunId | solo:<id>). */
  key: string;
  /** Newest createdAt among the batch's iterations (sort key for batches). */
  createdAt: number;
  iterations: EvalIteration[];
}

function readCompareRunId(
  metadata: Record<string, unknown> | undefined,
): string | null {
  const value = metadata?.["compareRunId"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The grouping key for a single iteration. Exported for reuse/tests. */
export function caseRunBatchKey(iteration: EvalIteration): string {
  if (iteration.suiteRunId) return `suite:${iteration.suiteRunId}`;
  const compareRunId = readCompareRunId(iteration.metadata);
  if (compareRunId) return `compare:${compareRunId}`;
  return `solo:${iteration._id}`;
}

export type CaseRunTrigger = "quick" | "suite" | "replay";

/**
 * Classify a batch as a quick run vs a suite run vs a replay.
 *
 * Primary signal is the backend's explicit `iteration.trigger` (stamped at
 * creation — unambiguous, and the only thing that can tell a replay apart from
 * a suite run). A batch's iterations share an origin, so the first one's
 * `trigger` decides the batch.
 *
 * Legacy rows (created before the `trigger` field) have no value, so we fall
 * back to the grouping-key heuristic: `suite:` ⇒ "suite"; everything else
 * (`compare:` editor run / `solo:` one-off) ⇒ "quick". Replay can't be
 * recovered from legacy data — it reads as "suite" — which is why the explicit
 * field exists going forward.
 */
export function caseRunBatchTrigger(
  batch: Pick<CaseRunBatch, "key" | "iterations">,
): CaseRunTrigger {
  const explicit = batch.iterations.find((it) => it.trigger != null)?.trigger;
  if (explicit) return explicit;
  return batch.key.startsWith("suite:") ? "suite" : "quick";
}

export type CaseRunBatchHost = {
  hostId?: string;
  hostName: string;
};

/** Parse the suite run id embedded in a batch key (`suite:<id>`). */
export function suiteRunIdFromBatchKey(key: string): string | null {
  if (!key.startsWith("suite:")) return null;
  const runId = key.slice("suite:".length);
  return runId.length > 0 ? runId : null;
}

/**
 * Resolve which host produced a run batch, when we can do so confidently.
 *
 * - Suite batches: read `namedHostId` from the parent suite run.
 * - Attachment-less suites: fall back to the suite's default host label.
 * - Quick runs on multi-host suites: omitted (no durable host stamp on iterations).
 */
export function resolveCaseRunBatchHost(
  batch: Pick<CaseRunBatch, "key" | "iterations">,
  options: {
    runsById?: Map<string, { namedHostId?: string }>;
    hostNamesById?: Map<string, string | null>;
    defaultHostLabel?: string | null;
    hasHostAttachments?: boolean;
  } = {},
): CaseRunBatchHost | null {
  const {
    runsById,
    hostNamesById,
    defaultHostLabel,
    hasHostAttachments = false,
  } = options;

  const suiteRunId = suiteRunIdFromBatchKey(batch.key);
  if (suiteRunId && runsById) {
    const run = runsById.get(suiteRunId);
    if (run?.namedHostId) {
      const hostName =
        hostNamesById?.get(run.namedHostId) ?? formatRunId(run.namedHostId);
      return {
        hostId: run.namedHostId,
        hostName: hostName ?? run.namedHostId,
      };
    }
  }

  if (!hasHostAttachments && defaultHostLabel) {
    return { hostName: defaultHostLabel };
  }

  return null;
}

export function groupCaseIterations(
  iterations: EvalIteration[],
): CaseRunBatch[] {
  const byKey = new Map<string, EvalIteration[]>();
  for (const iteration of iterations) {
    const key = caseRunBatchKey(iteration);
    const list = byKey.get(key);
    if (list) list.push(iteration);
    else byKey.set(key, [iteration]);
  }

  const batches: CaseRunBatch[] = [];
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => {
      const an = a.iterationNumber ?? 0;
      const bn = b.iterationNumber ?? 0;
      if (an !== bn) return an - bn;
      return (a.createdAt ?? 0) - (b.createdAt ?? 0);
    });
    const createdAt = sorted.reduce(
      (max, it) => Math.max(max, it.createdAt ?? 0),
      0,
    );
    batches.push({ key, createdAt, iterations: sorted });
  }

  return batches.sort((a, b) => b.createdAt - a.createdAt);
}
