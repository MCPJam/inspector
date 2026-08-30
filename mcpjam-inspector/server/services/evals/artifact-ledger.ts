/**
 * The run's artifact ledger, and the cleanup it drives.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A BENCHMARK RUN TIDIES UP AFTER ITSELF, WHATEVER ELSE HAPPENED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every artifact a write case creates on a third party's server is recorded
 * here as it is created, keyed by the id the server handed back. Two things
 * depend on that record and neither can be reconstructed later:
 *
 *   1. A mutation aimed at an id THIS RUN DID NOT CREATE is blocked. Without a
 *      ledger there is no way to tell "delete the page I just made" from
 *      "delete the operator's page", because both are a delete call with an id
 *      in it.
 *
 *   2. Cleanup is ledger-driven, so it works even when nothing else does. It
 *      runs in a `finally`, it makes NO model call, and it does not care why
 *      the run ended — a run that exhausted its budget still has to remove
 *      what it left behind. Cleanup that depended on an LLM would be skipped
 *      by exactly the failure that most needs it.
 *
 * IDEMPOTENT AND RETRIED. Deleting something already deleted is a success, not
 * an error, so a re-run of cleanup after a partial one converges. A step that
 * fails transiently is retried a bounded number of times; one that keeps
 * failing leaves RESIDUE, which is counted and reported rather than swallowed
 * — an operator whose server is holding our leftovers is entitled to know.
 */

import type {
  CaseCleanupStep,
  ResolvedCaseSideEffects,
} from "./side-effect-manifest.js";

/**
 * Everything a benchmark run needs to bound and undo its own writes, threaded
 * from the bench worker down to the per-iteration policy gate.
 *
 * One object rather than four options, because the four are meaningless apart:
 * a ledger with no manifests enforces nothing, and manifests with no ledger
 * cannot tell "the thing I made" from "the operator's thing".
 */
export type BenchmarkWriteGuard = {
  /** Part of every artifact name, so an artifact is traceable to its run. */
  benchmarkRunId: string;
  /**
   * Resolved by `suiteHash + caseId` and ALREADY verified against the pinned
   * `caseMetadataHash` — see `assertCaseMetadataPinned`. Verification happens
   * before a cell is launched, not here.
   */
  sideEffectsByCaseId: Record<string, ResolvedCaseSideEffects>;
  /**
   * This cell's exam contains a write case, so a case with no manifest is
   * refused rather than run unbounded. Absent/false leaves an unmanifested
   * case alone — an ordinary read-only exam has nothing to declare.
   */
  requireManifest?: boolean;
  /** Per RUN, not per iteration: cleanup is a property of the run. */
  ledger: BenchmarkArtifactLedger;
};

/** Attempts per cleanup step before an artifact is called residue. */
const CLEANUP_ATTEMPTS = 3;

export type ArtifactLedgerEntry = {
  /** The tool that created it — what the audit trail is about. */
  tool: string;
  /** The name the call carried, already prefix-checked by the gate. */
  artifactName: string;
  /** The id the server handed back; cleanup addresses this. */
  createdId: string;
  createdAt: number;
  /** The steps that can remove it, from the case's pinned manifest. */
  cleanupSteps: CaseCleanupStep[];
  /** The case whose manifest licensed the create. Sent with the durable row. */
  caseId?: string;
  /** Which repetition made it, so per-iteration prefixes stay traceable. */
  iteration?: number;
};

/**
 * Where a recorded artifact is written so it outlives this process.
 *
 * Async and fallible on purpose: the caller decides what a failed write means.
 * The ledger's own contract is only that {@link BenchmarkArtifactLedger.flush}
 * does not resolve until every recorded id has been offered to this sink.
 */
export type ArtifactLedgerSink = (
  entries: ReadonlyArray<ArtifactLedgerEntry>,
) => Promise<void>;

export type BenchmarkArtifactLedger = {
  record: (entry: Omit<ArtifactLedgerEntry, "createdAt">) => void;
  /** Did this run create the thing an id names? */
  has: (createdId: string) => boolean;
  entries: () => ReadonlyArray<ArtifactLedgerEntry>;
  /**
   * Resolves once every id recorded so far has been written durably.
   *
   * ── WHY THIS IS AWAITED BEFORE THE NEXT MUTATION ─────────────────────────
   *
   * The gate harvests an id from a create call's RESULT and then hands that
   * result back to the model. If the process dies in that window, the id dies
   * with it and the artifact stays in somebody else's tenant with nothing left
   * that knows its name. Awaiting here — inside the tool wrapper, before the
   * result is returned — means the model cannot issue the next call until the
   * id is somewhere a resumed worker can read it.
   *
   * Resolves immediately when the ledger has no sink: an ordinary eval has no
   * backend to write to, and a `flush` that blocked on nothing would be a
   * per-tool-call stall for every non-benchmark run.
   */
  flush: () => Promise<void>;
  /** Ids the sink refused, so the caller can decide whether to keep going. */
  unpersisted: () => ReadonlyArray<string>;
};

export function createBenchmarkArtifactLedger(options?: {
  /**
   * What this run already created, from a previous attempt.
   *
   * A resumed job inherits somebody else's cleanup: the artifacts exist
   * whether or not the worker that made them is still alive, so a resumed
   * worker that started from an empty ledger would report a clean run while
   * the rows sat in the target's tenant.
   */
  initial?: ReadonlyArray<Omit<ArtifactLedgerEntry, "createdAt">>;
  persist?: ArtifactLedgerSink;
}): BenchmarkArtifactLedger {
  const byId = new Map<string, ArtifactLedgerEntry>();
  const failed = new Set<string>();
  // Everything recorded locally and not yet accepted by the sink. Hydrated
  // entries are NOT queued: they are already durable, that is where they came
  // from.
  let pending: ArtifactLedgerEntry[] = [];
  let inFlight: Promise<void> = Promise.resolve();

  const remember = (entry: Omit<ArtifactLedgerEntry, "createdAt">) => {
    // Keyed by id, and the FIRST observation wins: a later call that reports
    // the same id must not be able to rewrite how the artifact gets removed.
    // Cleanup steps come from the case's manifest, and an artifact created
    // under one case has to stay removable by that case's steps even if a
    // second case later mentions the same id.
    if (byId.has(entry.createdId)) return null;
    const stored = { ...entry, createdAt: Date.now() };
    byId.set(entry.createdId, stored);
    return stored;
  };

  for (const entry of options?.initial ?? []) remember(entry);

  return {
    record: (entry) => {
      const stored = remember(entry);
      if (!stored || !options?.persist) return;
      pending.push(stored);
      // Serialized rather than fired in parallel: the backend's record
      // mutation is idempotent on `(run, tool, createdId)`, but two concurrent
      // writes of the same batch would still race the read that decides.
      inFlight = inFlight.then(async () => {
        const batch = pending;
        if (batch.length === 0) return;
        pending = [];
        try {
          await options.persist!(batch);
          for (const written of batch) failed.delete(written.createdId);
        } catch {
          // Kept, not rethrown: `flush` is awaited on the hot path and must
          // not turn a durable-write blip into a failed tool call. The ids
          // stay in `unpersisted()` so the caller can refuse to go on.
          for (const lost of batch) failed.add(lost.createdId);
        }
      });
    },
    has: (createdId) => byId.has(createdId),
    entries: () => [...byId.values()],
    flush: () => inFlight,
    unpersisted: () => [...failed],
  };
}

export type CleanupToolCall = (call: {
  tool: string;
  args: Record<string, unknown>;
}) => Promise<unknown>;

/**
 * Did that call actually do anything?
 *
 * ── A REFUSED CALL RESOLVES; IT DOES NOT REJECT ───────────────────────────
 *
 * `executeTool` answers an MCP tool error as a normal resolution carrying
 * `isError: true` — a permission refusal, an unknown id, a rate limit. Only a
 * TRANSPORT failure throws. Counting every resolution as a removal therefore
 * reported a refused delete as a successful cleanup: the scorecard said
 * `clean`, the residue count said zero, and the artifact was still sitting in
 * the operator's tenant with nothing left pointing at it.
 *
 * Read structurally rather than by hunting for words in the text: `isError` is
 * the protocol's own answer to this question, and a message-sniffing heuristic
 * would be wrong in both directions.
 */
function callRefused(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  return (result as { isError?: unknown }).isError === true;
}

export type ArtifactCleanupReport = {
  /**
   * `clean` — nothing was created, or everything created was removed.
   * `residual` — at least one artifact survived every attempt.
   * `skipped` — cleanup could not be attempted at all (no connection).
   *
   * A separate word from the count on purpose: zero residue because cleanup
   * ran and succeeded is a different statement from zero residue because
   * cleanup never happened, and a scorecard that printed the same thing for
   * both would be wrong exactly when it matters.
   */
  status: "clean" | "residual" | "skipped";
  attempted: number;
  removed: number;
  residue: number;
  /** Bounded so a pathological run cannot make the report the payload. */
  residualIds: string[];
};

const MAX_REPORTED_RESIDUAL_IDS = 50;

/** Place an id into a cleanup call's arguments at its pinned path. */
export function buildCleanupArgs(
  idArgPath: string,
  createdId: string,
): Record<string, unknown> {
  const segments = idArgPath.split(".").filter((segment) => segment.length > 0);
  if (segments.length === 0) return {};
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const next: Record<string, unknown> = {};
    cursor[segments[index]!] = next;
    cursor = next;
  }
  cursor[segments[segments.length - 1]!] = createdId;
  return root;
}

/**
 * Remove everything the ledger holds.
 *
 * Each artifact is tried against every cleanup step its case pinned, first
 * success wins. The fan-out is here because the manifest does not say which
 * cleanup step undoes which create rule — a `cleanupSteps[].forTool` would
 * make the pairing explicit and remove it. Until then the fan-out is the
 * conservative reading: trying a step that does not apply costs one refused
 * call, and skipping the step that did apply leaves an operator holding our
 * artifact.
 *
 * NEVER THROWS. Cleanup runs in a `finally` on a path that is already
 * unwinding; an exception here would replace whatever ended the run with a
 * cleanup complaint.
 */
export async function cleanupBenchmarkArtifacts(args: {
  ledger: BenchmarkArtifactLedger;
  callTool: CleanupToolCall;
  attempts?: number;
  onStepError?: (error: unknown, context: { tool: string; createdId: string }) => void;
}): Promise<ArtifactCleanupReport> {
  // Everything the DURABLE ledger holds, hydrated rows included. A resumed job
  // inherits the previous attempt's artifacts, and reconciling against only
  // what this process happened to create is how they get left behind.
  const entries = args.ledger.entries();
  if (entries.length === 0) {
    return {
      status: "clean",
      attempted: 0,
      removed: 0,
      residue: 0,
      residualIds: [],
    };
  }

  const attempts = Math.max(1, args.attempts ?? CLEANUP_ATTEMPTS);
  const residualIds: string[] = [];
  let removed = 0;

  for (const entry of entries) {
    let done = false;
    for (const step of entry.cleanupSteps) {
      for (let attempt = 0; attempt < attempts && !done; attempt += 1) {
        try {
          const result = await args.callTool({
            tool: step.tool,
            args: buildCleanupArgs(step.idArgPath, entry.createdId),
          });
          if (callRefused(result)) {
            // Treated exactly like a throw: retried within this step, and
            // falling through to the next step and then to residue if it keeps
            // coming back. What it must never be is `removed`.
            args.onStepError?.(
              new Error(
                `"${step.tool}" refused the cleanup call for ${entry.createdId}`,
              ),
              { tool: step.tool, createdId: entry.createdId },
            );
            continue;
          }
          done = true;
        } catch (error) {
          args.onStepError?.(error, {
            tool: step.tool,
            createdId: entry.createdId,
          });
        }
      }
      if (done) break;
    }
    if (done) removed += 1;
    else residualIds.push(entry.createdId);
  }

  return {
    status: residualIds.length === 0 ? "clean" : "residual",
    attempted: entries.length,
    removed,
    residue: residualIds.length,
    residualIds: residualIds.slice(0, MAX_REPORTED_RESIDUAL_IDS),
  };
}

/** The cleanup steps a case pins, or none when it declares no writes. */
export function cleanupStepsFor(
  sideEffects: ResolvedCaseSideEffects | undefined,
): CaseCleanupStep[] {
  return sideEffects?.mode === "test_write" ? sideEffects.cleanupSteps : [];
}
