/**
 * The run detail's user-value-chain slot: canonical document or legacy rollup,
 * never both (UVH-IN6).
 *
 * Two readings of the same six stages exist. The LEGACY rollup
 * (`evalStageRollups:getSuiteRunStageFunnel`) is a precomputed pass rate with
 * no reach/measured distinction. The CANONICAL document
 * (`EvalStageAnalyticsV1`) carries three rates per stage, named exclusions, and
 * the intent/model/host slices — it is the one the API publishes and the one
 * external readers cite.
 *
 * Rendering both would put two different numbers for one run on one screen,
 * which is worse than either alone: a reader cannot tell which is the report
 * card, and the two disagree by construction (different denominators, not a
 * bug). So this is an EXCLUSIVE choice, made in one place, with the legacy
 * branch labelled whenever the canonical one was actually attempted.
 *
 * ── The states, and why each renders what it does ────────────────────────────
 *
 *   flag off      → legacy, UNLABELLED. Today's page, unchanged. Nothing was
 *                   attempted, so there is nothing to distinguish it from.
 *   loading       → nothing. Legacy-then-canonical would flash one set of
 *                   numbers and replace it with different ones.
 *   ready         → canonical only.
 *   absent        → legacy, labelled. The run has no canonical document: it
 *                   terminalized before the materializer shipped, and that is
 *                   not backfilled. Also the answer for a run the caller
 *                   cannot see, which the API deliberately does not
 *                   distinguish.
 *   routeUnavailable → legacy, labelled the SAME way and with no alarm. This
 *                   is the dark-ship window — the flag is on before the route
 *                   is deployed — and it is expected, not a malfunction.
 *   other errors  → legacy, labelled, PLUS a one-line service note.
 *                   `requestFailed` and `invalidContract` are real failures,
 *                   and swapping silently to the older numbers would hide them.
 *
 * The legacy node is passed IN rather than mounted here so that this component
 * owns the rendering and not the construction: the caller already builds that
 * panel (with its own probe, error boundary and dark-ship behaviour) and there
 * is no reason for a second construction of it to exist.
 *
 * ── The hook is separate from the component, and called ONCE ─────────────────
 *
 * `useRunUserValueChainChoice` is exported and the renderer takes its result as
 * PROPS. That split exists because the caller needs the same answer for its own
 * emptiness check — the rail has to know whether to open before it mounts what
 * it would open around — and this hook wraps a plain `fetch`, not a Convex
 * subscription. Calling it in both places would issue two HTTP requests per
 * run, with nothing de-duplicating them. So the caller holds the one call and
 * hands the result down.
 */
import type { ReactNode } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import type { EvalStageAnalyticsV1 } from "@mcpjam/sdk/contract";
import { RunDocument } from "@/components/evaluate/stage-analytics-panel";
import { useEvalRunStageAnalytics } from "@/hooks/use-eval-run-stage-analytics";

/** The flag. Off everywhere until BE3 is deployed and this is enabled. */
export const RUN_STAGE_ANALYTICS_FLAG = "eval-run-stage-analytics";

/**
 * What the slot decided to draw. Exported for the caller's own emptiness
 * checks — the rail it sits in has to know whether to open at all, and it
 * cannot ask a node whether it rendered anything.
 */
export type RunUserValueChainChoice = "canonical" | "legacy" | "nothing";

/** One decision about one run's chain slot. */
export type RunUserValueChain = {
  choice: RunUserValueChainChoice;
  document: EvalStageAnalyticsV1 | null;
  /** A one-line service note, or null. Never set for the expected states. */
  serviceNote: string | null;
  /** Whether the canonical read was attempted at all — gates the label. */
  attempted: boolean;
  /**
   * WHY the legacy rollup is on screen, when it is.
   *
   * `absent` is a fact about the RUN — it has no canonical document and never
   * will. `unreadable` is a fact about this ATTEMPT — a document may well
   * exist and we could not get it. Saying the first when the second is true
   * reports a transient outage as a permanent absence, which is exactly the
   * kind of over-claim the rest of this work removes.
   */
  fallbackReason: "absent" | "unreadable" | null;
};

export function useRunUserValueChainChoice({
  projectId,
  runId,
  runStatus,
}: {
  projectId: string | null | undefined;
  runId: string | null | undefined;
  /**
   * Passed through so a page opened MID-RUN re-asks once the run finishes.
   * The document is materialized on terminalization, so without this the
   * first (too-early) answer would stand until the view remounted.
   */
  runStatus?: string | null;
}): RunUserValueChain {
  // `=== true` on purpose: the hook returns `undefined` while PostHog is still
  // loading its flags, and `undefined` must read as OFF. Without this, the
  // slot would briefly attempt a read on every page load for every user.
  const enabled = useFeatureFlagEnabled(RUN_STAGE_ANALYTICS_FLAG) === true;
  const { status, document, error } = useEvalRunStageAnalytics({
    projectId,
    runId,
    ...(runStatus !== undefined ? { runStatus } : {}),
    enabled,
  });

  if (!enabled) {
    return {
      choice: "legacy",
      document: null,
      serviceNote: null,
      attempted: false,
      fallbackReason: null,
    };
  }
  if (status === "loading" || status === "idle") {
    return {
      choice: "nothing",
      document: null,
      serviceNote: null,
      attempted: true,
      fallbackReason: null,
    };
  }
  if (status === "ready" && document) {
    return {
      choice: "canonical",
      document,
      serviceNote: null,
      attempted: true,
      fallbackReason: null,
    };
  }
  // Everything else falls back to legacy. Only a REAL failure says so out
  // loud: `absent` and the dark-ship window are both expected.
  const serviceNote =
    status === "error" && error && error.kind !== "routeUnavailable"
      ? error.kind === "invalidContract"
        ? "The canonical stage analytics for this run did not match the published contract, so the older rollup is shown."
        : "The canonical stage analytics for this run could not be read, so the older rollup is shown."
      : null;
  return {
    choice: "legacy",
    document: null,
    serviceNote,
    attempted: true,
    // Only a 404 establishes that the run HAS no document. Every error kind —
    // the dark-ship window included — means we could not read one, which is a
    // different claim and a recoverable one.
    fallbackReason: status === "absent" ? "absent" : "unreadable",
  };
}

export function RunUserValueChainSlot({
  chain,
  legacy,
  className,
}: {
  /** The caller's ONE `useRunUserValueChainChoice` result. See the docblock. */
  chain: RunUserValueChain;
  /** The existing rollup panel, built by the caller. */
  legacy: ReactNode;
  className?: string;
}) {
  const { choice, document, serviceNote, attempted, fallbackReason } = chain;

  if (choice === "nothing") return null;

  if (choice === "canonical" && document) {
    return (
      <div className={className} data-testid="run-stage-analytics-canonical">
        <RunDocument row={document} />
      </div>
    );
  }

  return (
    <>
      {attempted ? (
        <p
          className="mx-3 mt-3 text-[10px] text-muted-foreground/80"
          data-testid="run-stage-analytics-legacy-label"
        >
          {/* Named, not hedged. A reader on the flag needs to know which of the
              two readings is on screen — the older one has no reach/measured
              split and no slices, so its numbers are not comparable to the
              canonical document's. */}
          {/* The REASON is not guessed either: a 404 means the run has no
              document, while any read error means we could not fetch one.
              Reporting a transient outage as a permanent absence would be the
              same over-claim this work exists to remove. */}
          {fallbackReason === "unreadable"
            ? "Older stage rollup — the canonical stage analytics could not be read for this run."
            : "Older stage rollup — this run has no canonical stage analytics."}
        </p>
      ) : null}
      {serviceNote ? (
        <p
          className="mx-3 mt-1 text-[10px] text-amber-700 dark:text-amber-400"
          data-testid="run-stage-analytics-service-note"
        >
          {serviceNote}
        </p>
      ) : null}
      {legacy}
    </>
  );
}
