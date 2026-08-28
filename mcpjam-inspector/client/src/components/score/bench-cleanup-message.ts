import { benchCleanupState, type BenchRunCleanup } from "@/lib/apis/bench-api";

/**
 * What we are entitled to tell a visitor about their connector after a cancel.
 *
 * Cancelling marks the run terminal IMMEDIATELY — the worker may still be
 * deleting things when this renders. So "anything it wrote was still cleaned
 * up", printed unconditionally on that branch, was a promise about somebody
 * else's tenant that nothing had checked: it was equally cheerful when the
 * ledger recorded residue, and when no cleanup had been attempted at all.
 *
 * The counts are the only evidence there is, and only one reading of them
 * earns the reassurance.
 */
export function benchCancelledCleanupMessage(
  cleanup: BenchRunCleanup | undefined,
): string {
  const state = benchCleanupState(cleanup);
  switch (state.kind) {
    case "clean":
      return state.removed === 0
        ? "This run created nothing on your connector."
        : `Everything it created on your connector was removed (${state.removed}).`;
    case "residual":
      // Named, not softened: these are objects sitting in the visitor's tenant
      // that they now have to remove by hand, and a vague sentence would leave
      // them there.
      return `${state.residue} of ${state.recorded} item${
        state.recorded === 1 ? "" : "s"
      } this run created could not be removed, and may still be on your connector.`;
    case "in_progress":
      return `Cleanup is still running — ${state.removed} of ${state.recorded} removed so far.`;
    case "unreported":
      // The backend omits the ledger when it holds nothing, which is BOTH "this
      // exam only reads" and "the worker stopped before recording anything".
      // Those are different situations and this cannot tell them apart, so it
      // says what it knows instead of guessing the comfortable one.
      return "We have no cleanup report for this run yet.";
  }
}
