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
      return "Everything it created on your connector was removed.";
    case "residual":
      // Named, not softened: these are objects sitting in the visitor's tenant
      // that they now have to remove by hand, and a vague sentence leaves them
      // there.
      return `${state.residue} item${
        state.residue === 1 ? "" : "s"
      } this run created could not be removed, and may still be on your connector.`;
    case "in_progress":
      return "Cleanup is still running — we do not know yet what it managed to delete.";
    case "nothing_created":
      return "This exam only reads, so nothing was created on your connector.";
    case "unreported":
      // Different from `not_applicable`: that one is the backend saying there
      // was nothing to clean, this one is the backend not saying anything.
      return "We have no cleanup report for this run yet.";
  }
}
