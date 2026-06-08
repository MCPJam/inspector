/**
 * ChatSessionVerdicts — sourceType-agnostic verdict renderer for a single
 * `chatSessions` row, driven by the Layer-A `chatSessionChecks` table.
 *
 * Layer C UI for cross-surface checks. Subscribes to all check runs for
 * `chatSessionId` (via `chatSessionChecks.getCheckRunsForSession`) and
 * renders each one's status + predicate verdicts. Re-uses
 * `<PredicateVerdictRow>` from the eval predicate-list component so the
 * rendered rows look identical to eval — eval still owns its own renderer
 * (it reads from `testIteration.metadata.predicates`, not these chat-session
 * check rows). That migration is deferred.
 *
 * Empty state is the common case for sessions that have never had checks
 * run on them; we render an explicit hint so the panel doesn't look broken.
 */
import { useQuery } from "convex/react";
import { useConvexAuth } from "convex/react";
import { Loader2 } from "lucide-react";
import { PredicateVerdictRow } from "@/components/evals/predicates-list";
import { summarizePredicate } from "@/components/evals/predicates-list";
import type { ChatSessionCheckRow } from "@/hooks/use-chat-session";

interface Props {
  chatSessionId: string;
}

export function ChatSessionVerdicts({ chatSessionId }: Props) {
  const { isAuthenticated } = useConvexAuth();
  // Same string-form cast pattern as `useChatSession.checks` — codegen for
  // `api.chatSessionChecks.*` lands with backend PR #453.
  const checks = useQuery(
    "chatSessionChecks:getCheckRunsForSession" as unknown as Parameters<
      typeof useQuery
    >[0],
    isAuthenticated && chatSessionId
      ? ({ chatSessionId } as unknown as Parameters<typeof useQuery>[1])
      : "skip",
  ) as ChatSessionCheckRow[] | undefined;

  if (checks === undefined) {
    return (
      <div
        role="status"
        aria-label="Loading check runs"
        className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/10 p-3 text-xs text-muted-foreground"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Loading checks…</span>
      </div>
    );
  }

  if (checks.length === 0) {
    return (
      <div
        role="region"
        aria-label="Checks"
        className="rounded-md border border-dashed border-border/40 bg-muted/10 p-3 text-xs text-muted-foreground"
        data-testid="chat-session-verdicts-empty"
      >
        No checks run on this session yet.
      </div>
    );
  }

  // Newest first — most recently kicked-off check is the one the user just
  // clicked "Run". Backend writes `_creationTime` automatically.
  const ordered = [...checks].sort(
    (a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0),
  );

  return (
    <div
      role="region"
      aria-label="Checks"
      className="flex flex-col gap-3"
      data-testid="chat-session-verdicts"
    >
      {ordered.map((run) => (
        <CheckRunCard key={run._id} run={run} />
      ))}
    </div>
  );
}

function CheckRunCard({ run }: { run: ChatSessionCheckRow }) {
  const setKindLabel = formatSetKind(run.setKind);
  const versionLabel =
    run.setVersion !== undefined ? ` · v${run.setVersion}` : "";

  return (
    <div
      className="space-y-2 rounded-md border border-border/40 bg-muted/10 p-3"
      data-testid={`check-run-${run._id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusBadge status={run.status} />
          <span className="truncate text-[11px] text-muted-foreground">
            {setKindLabel}
            {versionLabel}
          </span>
        </div>
        {run.predicateResults ? (
          <SummaryBadge results={run.predicateResults} />
        ) : null}
      </div>

      {run.status === "failed" && run.errorMessage ? (
        <div
          role="alert"
          className="rounded border border-destructive/50 bg-destructive/10 p-2 text-[11px] text-destructive"
        >
          {run.errorMessage}
        </div>
      ) : null}

      {run.status === "running" ? (
        <PredicateListPreview predicates={run.predicates} />
      ) : null}

      {run.status === "completed" && run.predicateResults ? (
        <ul className="space-y-1.5">
          {run.predicateResults.map((row, i) => (
            <PredicateVerdictRow key={i} row={row} />
          ))}
        </ul>
      ) : null}

      {run.judge ? (
        <div
          className="rounded border border-border/40 bg-background/40 p-2 text-[11px]"
          data-testid="check-run-judge"
        >
          <div className="font-semibold uppercase tracking-wide text-muted-foreground">
            Judge
          </div>
          <div className="mt-0.5">
            {run.judge.passed ? "PASS" : "FAIL"}
            {typeof run.judge.score === "number"
              ? ` · score ${run.judge.score.toFixed(2)}`
              : ""}
          </div>
          {run.judge.rationale ? (
            <div className="mt-1 whitespace-pre-wrap text-muted-foreground">
              {run.judge.rationale}
            </div>
          ) : null}
        </div>
      ) : null}

      {run.goalCompletion ? (
        <div
          className="rounded border border-border/40 bg-background/40 p-2 text-[11px]"
          data-testid="check-run-goal"
        >
          <div className="font-semibold uppercase tracking-wide text-muted-foreground">
            Goal completion
          </div>
          <div className="mt-0.5">
            {run.goalCompletion.completed ? "Completed" : "Not completed"}
          </div>
          {run.goalCompletion.rationale ? (
            <div className="mt-1 whitespace-pre-wrap text-muted-foreground">
              {run.goalCompletion.rationale}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: ChatSessionCheckRow["status"] }) {
  const label =
    status === "running"
      ? "RUNNING"
      : status === "completed"
        ? "COMPLETED"
        : "FAILED";
  const className =
    status === "running"
      ? "bg-muted/60 text-foreground"
      : status === "completed"
        ? "bg-success/50 text-foreground"
        : "bg-destructive/50 text-foreground";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${className}`}
      aria-label={`status: ${status}`}
    >
      {status === "running" ? (
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
      ) : null}
      {label}
    </span>
  );
}

function SummaryBadge({ results }: { results: ChatSessionCheckRow["predicateResults"] }) {
  if (!results || results.length === 0) return null;
  const failed = results.filter((r) => !r.passed).length;
  const passed = results.length - failed;
  const allPassed = failed === 0;
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
        allPassed
          ? "bg-success/50 text-foreground"
          : "bg-destructive/50 text-foreground"
      }`}
    >
      {passed} / {results.length} passed
    </span>
  );
}

function PredicateListPreview({
  predicates,
}: {
  predicates: ChatSessionCheckRow["predicates"];
}) {
  if (predicates.length === 0) {
    return (
      <div className="text-[11px] italic text-muted-foreground">
        (empty predicate set)
      </div>
    );
  }
  return (
    <ul className="space-y-0.5 text-[11px] text-muted-foreground">
      {predicates.map((p, i) => (
        <li key={i} className="font-mono">
          {p.type}
          {summarizePredicate(p) ? ` — ${summarizePredicate(p)}` : ""}
        </li>
      ))}
    </ul>
  );
}

function formatSetKind(kind: ChatSessionCheckRow["setKind"]): string {
  switch (kind) {
    case "suite_defaults":
      return "Suite defaults";
    case "case_resolved":
      return "Test case checks";
    case "ad_hoc":
      return "Ad-hoc";
  }
}
