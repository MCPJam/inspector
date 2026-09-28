/**
 * One session's user-value chain.
 *
 * Six stages, in chain order, with what each one did and why. It sits beside
 * the surface's own verdict — a readiness strip, a rubric result, a swarm
 * judge — and never replaces it: the chain EXPLAINS an outcome, and a panel
 * that let it look like the outcome would be a second, quieter verdict nobody
 * agreed to.
 *
 * ── What this component refuses to do ────────────────────────────────────────
 *
 *  - **Derive.** Every row is read off `chatSessions.stageDerivation` exactly
 *    as the backend stored it. There is no fold, no inference, no "if there
 *    are tool calls then…". D10a's rule, and D8's: React renders, Convex
 *    persists, the SDK derives.
 *  - **Collapse the three non-verdicts.** `notMeasured`, `notApplicable` and
 *    `notReached` get three different sentences, because "we did not check",
 *    "it does not apply" and "it never ran" are three different facts and one
 *    shared grey dot is how "we never checked" gets read as "it passed".
 *  - **Say "root cause".** A first failed stage is where the chain stopped. It
 *    is not a claim about why, and phrasing that suggests otherwise is how an
 *    operator ends up fixing the wrong system.
 *  - **Hide staleness.** A chain whose evidence has moved is still shown —
 *    with a label. Blanking it would empty the panel on every re-grade.
 *
 * Every user-facing word comes from the SDK's canonical label maps, which are
 * total over their vocabularies: adding a stage reason breaks the label file
 * until somebody writes the words a human reads, rather than silently
 * rendering a wire enum here.
 */

import { AlertTriangle, Check, Circle, Loader2, Minus, X } from "lucide-react";
import {
  FAILURE_CATEGORY_LABELS,
  STAGE_ANALYZER_VERSION,
  STAGE_REASON_LABELS,
  STAGE_STATE_LABELS,
  USER_VALUE_STAGE_LABELS,
  type StageState,
} from "@mcpjam/sdk/contract";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import {
  chainPresentation,
  type ChatSessionStageDerivation,
  type StageResultRow,
} from "./user-value-chain-types";

/**
 * Per-state presentation.
 *
 * Five entries because there are five states, and `satisfies` keeps it that
 * way: a sixth state would break this file rather than fall through to a
 * default that renders it as one of the others.
 */
const STATE_META = {
  passed: {
    Icon: Check,
    dot: "text-emerald-600 dark:text-emerald-400",
    rail: "bg-emerald-500",
  },
  failed: {
    Icon: X,
    dot: "text-red-600 dark:text-red-400",
    rail: "bg-red-500",
  },
  notReached: {
    Icon: Minus,
    dot: "text-muted-foreground",
    rail: "bg-muted-foreground/30",
  },
  notMeasured: {
    Icon: Circle,
    dot: "text-muted-foreground",
    rail: "bg-muted-foreground/20",
  },
  notApplicable: {
    Icon: Minus,
    dot: "text-muted-foreground/60",
    rail: "bg-muted-foreground/10",
  },
} satisfies Record<
  StageState,
  { Icon: typeof Check; dot: string; rail: string }
>;

/**
 * For a state this build has no words for.
 *
 * `STATE_META` is total over THIS build's `StageState`, but `row.state` arrives
 * off the wire — and the footer below says out loud that rows may come from a
 * build ahead of this one. Indexing with an unknown member would yield
 * `undefined` and throw on `.Icon`, and this component is mounted in the
 * session detail pane with no boundary above it: a sixth state would take the
 * transcript, the judge and the checks down with it. Degrade, never throw.
 */
const UNKNOWN_STATE_META = {
  Icon: Circle,
  dot: "text-muted-foreground/60",
  rail: "bg-muted-foreground/10",
};

function StageRow({ row }: { row: StageResultRow }) {
  const meta = STATE_META[row.state] ?? UNKNOWN_STATE_META;
  // Falls back to the wire spelling for the same reason the stage label does,
  // and it matters MORE here: an unrecognized reason with no fallback is not
  // rendered blank, it is not rendered at all — the line disappears, and the
  // row silently loses the only thing that says WHY it landed where it did.
  const reason = row.reason
    ? STAGE_REASON_LABELS[row.reason] ?? row.reason
    : null;
  const evidenceReasons = row.evidence?.predicateReasons ?? [];

  return (
    <li className="flex items-start gap-2.5 py-1.5" data-stage={row.stage}>
      <span className={cn("mt-0.5 shrink-0", meta.dot)} aria-hidden="true">
        <meta.Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">
          {/* The wire spelling is a poor label, but it is a better one than
              blank: an unknown stage still tells a reader something, and
              rendering `undefined` tells them nothing at all. */}
          {USER_VALUE_STAGE_LABELS[row.stage] ?? row.stage}{" "}
          <span className="font-normal text-muted-foreground">
            {STAGE_STATE_LABELS[row.state] ?? "state not recognized"}
          </span>
        </p>
        {reason ? (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {reason}
          </p>
        ) : null}
        {evidenceReasons.length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {evidenceReasons.map((entry, index) => (
              <li
                key={index}
                className="text-[11px] leading-snug text-muted-foreground/80"
              >
                {entry}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

function ChainNotice({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "warning";
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        "text-[11px] leading-snug",
        tone === "warning"
          ? "text-amber-600 dark:text-amber-400"
          : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

/**
 * Does this derivation come from an analyzer NEWER than the build rendering it?
 *
 * DERIVED, not trusted. `analyzerVersionAhead` is stamped by the backend at the
 * moment a chain arrives, and raising a version constant does not rewrite
 * stored rows — so a session derived while this build lagged its producer kept
 * claiming to be newer FOREVER, long after the claim stopped being true.
 *
 * The version it was derived at is on the same object, so compare that instead.
 * Self-healing for any future window and needs no migration: the claim goes
 * false the moment it stops being true. Mirrors what the SDK's own
 * `assembleChain` already does for eval runs, down to reporting both numbers.
 *
 * The stored boolean survives only as a FALLBACK, for rows written before the
 * version was recorded — nothing that was flagged loses its warning.
 */
export function analyzerVersionAhead(
  derivation: ChatSessionStageDerivation | null | undefined,
): boolean {
  if (!derivation) return false;
  const reported = derivation.stageAnalyzerVersion;
  if (typeof reported === "number") return reported > STAGE_ANALYZER_VERSION;
  return derivation.analyzerVersionAhead === true;
}

export function SessionUserValueChain({
  derivation,
  className,
}: {
  /**
   * `chatSessions.stageDerivation`, or `null`/`undefined` when the session has
   * none. Absence is rendered explicitly rather than hidden — a session with
   * no chain is unmeasured, and a panel that vanished would read as "nothing
   * to report".
   */
  derivation: ChatSessionStageDerivation | null | undefined;
  className?: string;
}) {
  const presentation = chainPresentation(derivation);
  const versionAhead = analyzerVersionAhead(derivation);

  return (
    <section
      className={cn("rounded-md border border-border/60 p-3", className)}
      aria-label="User value chain"
      data-presentation={presentation}
    >
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-foreground">
          User value chain
        </h3>
        {presentation === "deriving" || presentation === "stale" ? (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            Deriving
          </span>
        ) : null}
      </header>

      {presentation === "absent" ? (
        <ChainNotice>
          {derivation?.status === "failed"
            ? "This session's chain could not be derived, so it is unmeasured. Nothing here says anything about the server."
            : "Not measured for this session. Sessions that predate the chain — and any the analyzer has not been asked about — carry none."}
        </ChainNotice>
      ) : null}

      {presentation === "deriving" ? (
        <ChainNotice>
          A chain is being derived for this session. Nothing has been measured
          yet.
        </ChainNotice>
      ) : null}

      {derivation?.stageResults ? (
        <>
          {presentation === "stale" ? (
            <ChainNotice tone="warning">
              This session's evidence has changed since these stages were
              derived. A newer chain is on its way; what follows describes the
              earlier evidence.
            </ChainNotice>
          ) : null}

          <ul className="mt-1 divide-y divide-border/40">
            {derivation.stageResults.map((row) => (
              <StageRow key={row.stage} row={row} />
            ))}
          </ul>

          <footer className="mt-2 space-y-1 border-t border-border/40 pt-2">
            {derivation.firstFailedStage ? (
              <p className="text-[11px] text-muted-foreground">
                {/* WHERE it stopped. Deliberately not "why", and deliberately
                    never "root cause": this is a position in the chain. */}
                The chain stopped at{" "}
                <span className="font-medium text-foreground">
                  {USER_VALUE_STAGE_LABELS[derivation.firstFailedStage] ??
                    derivation.firstFailedStage}
                </span>
                {derivation.failureCategory ? (
                  <>
                    , grouped under{" "}
                    {FAILURE_CATEGORY_LABELS[derivation.failureCategory] ??
                      derivation.failureCategory}
                  </>
                ) : null}
                .
              </p>
            ) : null}
            {!derivation.firstFailedStage && derivation.failureCategory ? (
              <p className="text-[11px] text-muted-foreground">
                No stage failed. This session is grouped under{" "}
                {FAILURE_CATEGORY_LABELS[derivation.failureCategory] ??
                  derivation.failureCategory}
                .
              </p>
            ) : null}
            {versionAhead ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <p className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                    Derived by a newer analyzer
                  </p>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  These rows came from a build ahead of this one. They are shown
                  as sent rather than discarded, but some of what they say may
                  not be in this build's vocabulary.
                </TooltipContent>
              </Tooltip>
            ) : null}
          </footer>
        </>
      ) : null}
    </section>
  );
}
