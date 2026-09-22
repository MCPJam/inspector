/**
 * Per-session deterministic-check verdicts, on the shared session-detail
 * surface (Swarms sessions + User Testing sessions).
 *
 * This is the first UI to show the evaluator's `reason` strings. They have
 * always been persisted — `chatSessionChecks.criterionResults[].reason` is the
 * only place they live, deliberately dropped from the compact
 * `chatSessions.criteria` projection — and until now nothing rendered them, so
 * a failing check could be counted on a scorecard but never explained.
 *
 * Scope, and why the panel is sometimes absent:
 *
 *  - EVAL sessions store their verdicts on `testIteration.metadata.predicates`
 *    by design and write no `chatSessionChecks` rows at all. That is not a
 *    gap: the eval surfaces render `PredicatesList` against that metadata, and
 *    this panel stays hidden there rather than showing a misleading "no
 *    checks".
 *  - JUDGE rows live in the same table and are excluded here — the judge is
 *    its own section (`SwarmJudgeSection`) answering a different question with
 *    different evidence. Its failures are not swallowed by that exclusion:
 *    `ShareUsageThreadDetail` renders judge errors off `thread.goalScore`,
 *    which is written on the same transaction as the judge's check row.
 *
 * Statuses stay distinct from verdicts throughout. "Grading broke" and "the
 * check failed" are different facts, and folding a dead runner into a fail
 * count is how an infrastructure hiccup starts reading as a product
 * regression.
 */

import { useMemo } from "react";
import { useQuery } from "convex/react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  checkRunOriginLabel,
  isChecksRun,
  sortCheckRunsNewestFirst,
  toCheckVerdicts,
  type CheckVerdict,
  type SessionCheckRun,
} from "./session-check-runs";

const PASS_BADGE_CLASS =
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
const FAIL_BADGE_CLASS = "bg-red-500/15 text-red-700 dark:text-red-400";

export function SessionChecksSection({
  chatSessionId,
}: {
  /**
   * The `chatSessions` doc id. Passed explicitly by the caller off
   * `thread._id` rather than derived from an incidental id field on the
   * thread view-model — those are not all the same id.
   */
  chatSessionId: string | undefined;
}) {
  // Authorization note: `getCheckRunsForSession` gates on exactly the same
  // `resolveAuthorizedChatSession(ctx, sessionId, actor)` call that
  // `chatSessions:getSession` uses to load the thread this panel sits in. So
  // any viewer who got this far is already authorized here — mounting the
  // subscription cannot turn a readable session into a thrown query.
  //
  // Unbounded `.collect()` on the backend. Fine at current volumes (one
  // upserted row per swarm session, plus a row per on-demand re-grade);
  // revisit when WS1 starts grading production traffic.
  const rows = useQuery(
    "chatSessionChecks:getCheckRunsForSession" as never,
    (chatSessionId ? { chatSessionId } : "skip") as never
  ) as SessionCheckRun[] | null | undefined;

  const runs = useMemo(
    () => sortCheckRunsNewestFirst((rows ?? []).filter(isChecksRun)),
    [rows]
  );

  // Nothing this panel owns. Silence, not an empty section advertising a
  // feature this session never opted into.
  if (runs.length === 0) return null;

  const [current, ...older] = runs;
  // A runner failure is never hidden by age. Everything else folds into the
  // disclosure; failed runs are pulled out and rendered unconditionally, so
  // "grading broke three runs ago" is visible without a click.
  const olderFailed = older.filter((run) => run.status === "failed");
  const olderRest = older.filter((run) => run.status !== "failed");

  return (
    <section
      aria-label="Checks"
      data-testid="session-checks-section"
      className="shrink-0 space-y-1.5 px-4 pt-2"
    >
      <CheckRunGroup run={current} defaultOpen />
      {/* Index is the last-resort key: both id fields are optional on the
          deliberately-loose wire type, and `key={undefined}` is a missing key
          as far as React is concerned. */}
      {olderFailed.map((run, index) => (
        <CheckRunGroup
          key={run._id ?? run.checkRunId ?? `failed-${index}`}
          run={run}
          defaultOpen
        />
      ))}
      {olderRest.length > 0 ? (
        <details className="group rounded-lg border border-border/50 bg-muted/10">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 shrink-0 group-open:hidden" />
            <ChevronDown className="hidden size-3 shrink-0 group-open:block" />
            Previous runs ({olderRest.length})
          </summary>
          <div className="space-y-1.5 px-1.5 pb-1.5">
            {olderRest.map((run, index) => (
              <CheckRunGroup
                key={run._id ?? run.checkRunId ?? `older-${index}`}
                run={run}
              />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

/**
 * One check run: its origin and lifecycle status in the header, its verdicts
 * below.
 *
 * `defaultOpen` opens the whole group; individual FAILED verdict rows also
 * start expanded regardless, matching `PredicatesList` — the reason a check
 * failed is the thing a reader came for, and burying it behind a second click
 * is what made these strings invisible for so long.
 */
function CheckRunGroup({
  run,
  defaultOpen = false,
}: {
  run: SessionCheckRun;
  defaultOpen?: boolean;
}) {
  const verdicts = toCheckVerdicts(run);
  const failed = verdicts.filter((verdict) => !verdict.passed).length;
  const passed = verdicts.length - failed;

  return (
    <div className="rounded-lg border border-border/50 bg-muted/15">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Checks
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {checkRunOriginLabel(run)}
        </span>
        <RunStatusBadge status={run.status} />
        {verdicts.length > 0 ? (
          <span
            className={cn(
              "ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold",
              failed === 0 ? PASS_BADGE_CLASS : FAIL_BADGE_CLASS
            )}
          >
            {passed} / {verdicts.length} passed
          </span>
        ) : null}
      </div>

      {run.status === "failed" && run.error ? (
        <p className="px-3 pb-2 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">Grading failed:</span>{" "}
          {run.error}
        </p>
      ) : null}

      {verdicts.length > 0 ? (
        <ul className="space-y-1 px-1.5 pb-1.5">
          {verdicts.map((verdict) => (
            <CheckVerdictRow
              key={verdict.key}
              verdict={verdict}
              defaultOpen={defaultOpen}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The run's lifecycle, kept visually separate from any check's verdict.
 * `completed` gets no badge — it is the boring case, and a green "completed"
 * chip beside a red fail count reads as a contradiction.
 */
function RunStatusBadge({ status }: { status?: string }) {
  if (status === "running") {
    return (
      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Running
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex items-center gap-1 text-[10px] font-medium text-amber-700 dark:text-amber-400">
        <AlertTriangle className="size-3" aria-hidden />
        Not graded
      </span>
    );
  }
  return null;
}

function CheckVerdictRow({
  verdict,
  defaultOpen,
}: {
  verdict: CheckVerdict;
  defaultOpen: boolean;
}) {
  return (
    <li
      className={cn(
        "rounded border",
        verdict.passed
          ? "border-border/40 bg-background/40"
          : "border-red-500/40 bg-red-500/5"
      )}
    >
      <details className="group/row" open={defaultOpen || !verdict.passed}>
        <summary className="flex cursor-pointer list-none items-start gap-2 p-2 [&::-webkit-details-marker]:hidden">
          <span
            className={cn(
              "mt-0.5 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold",
              verdict.passed ? PASS_BADGE_CLASS : FAIL_BADGE_CLASS
            )}
          >
            {verdict.passed ? (
              <CheckCircle2 className="size-3" aria-hidden />
            ) : (
              <XCircle className="size-3" aria-hidden />
            )}
            {verdict.passed ? "PASS" : "FAIL"}
          </span>
          <span className="min-w-0 flex-1 text-xs font-medium">
            {verdict.name}
          </span>
          <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground group-open/row:hidden" />
          <ChevronDown className="mt-0.5 hidden size-3.5 shrink-0 text-muted-foreground group-open/row:block" />
        </summary>
        {verdict.reason ? (
          <p
            className={cn(
              "whitespace-pre-wrap break-words px-2 pb-2 pl-[26px] text-[11px] leading-tight",
              verdict.passed
                ? "text-muted-foreground"
                : "text-red-600 dark:text-red-400"
            )}
          >
            {verdict.reason}
          </p>
        ) : null}
      </details>
    </li>
  );
}
