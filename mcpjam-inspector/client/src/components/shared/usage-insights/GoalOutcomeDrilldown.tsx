import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  EvalInspectBody,
  EvalInspectHeader,
  EvalInspectSheet,
} from "@/components/evaluate/eval-inspect-sheet";
import {
  useGoalOutcomeDrilldown,
  type InsightsScope,
} from "@/hooks/useUsageInsights";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";
import {
  chipKey,
  isEmptySelection,
  selectionChips,
  type InsightsSelection,
  type UsageFilterState,
} from "@/hooks/scenario-usage-filters";
import {
  CaseListColumnHeaders,
  caseListCardClassName,
  caseListDataRowClassName,
} from "@/components/evals/case-list-shared";
import { formatRelativeTime } from "@/components/evals/helpers";
import { ShareUsageThreadDetail } from "@/components/connection/share-usage/ShareUsageThreadDetail";
import { cn } from "@/lib/utils";

/**
 * Sessions behind one selection in the session flow — a node, or a link's two
 * endpoints.
 *
 * Paged server-side. The flow shows exact counts and this list has to be able to
 * reach all of them, which the insights list's fixed 100-row fetch plus a
 * client-side filter could not do — it would silently show a subset whose total
 * disagreed with the number the user clicked.
 */
const PAGE_SIZE = 25;

type DrilldownRow = Pick<
  SharedChatThread,
  | "_id"
  | "firstMessagePreview"
  | "lastActivityAt"
  | "outcome"
  | "messageCount"
  | "modelId"
>;

function sessionRowMeta(session: DrilldownRow): string | null {
  const parts: string[] = [];
  if (session.outcome) {
    parts.push(
      session.outcome.charAt(0).toUpperCase() + session.outcome.slice(1),
    );
  }
  if (session.messageCount != null) {
    parts.push(
      `${session.messageCount} message${session.messageCount === 1 ? "" : "s"}`,
    );
  }
  if (session.modelId) parts.push(session.modelId);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function DrilldownSessionRow({
  session,
  onOpen,
}: {
  session: DrilldownRow;
  onOpen: (id: string) => void;
}) {
  const preview = session.firstMessagePreview?.trim() || "(no preview)";
  const meta = sessionRowMeta(session);
  return (
    <button
      type="button"
      data-testid={`goal-outcome-session-${session._id}`}
      title={preview}
      aria-label={`Open session: ${preview}`}
      onClick={() => onOpen(session._id)}
      className={cn(
        caseListDataRowClassName({ isSelected: false }),
        "items-start text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-sm font-medium text-foreground">
          {preview}
        </span>
        {meta ? (
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {meta}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
        {formatRelativeTime(session.lastActivityAt)}
      </span>
    </button>
  );
}

interface GoalOutcomeDrilldownProps {
  /** Which surface's sessions to page: a scenario or a project's swarm. */
  scope: InsightsScope;
  /** The open flow selection, or null when nothing is selected. */
  selection: InsightsSelection | null;
  /**
   * The full active filter, which already carries this selection's own chips.
   * Stages other than goal and outcome narrow through those chips alone, the
   * same way the Sessions list and the topic map read them.
   */
  filter: UsageFilterState;
  onClose: () => void;
  /**
   * Optional escape hatch to the Sessions tab. Row clicks preview the
   * transcript in this sheet — the same in-place pattern as evals — rather
   * than navigating away.
   */
  onOpenSession?: (sessionId: string) => void;
  /** Panel keeps the list itself scrollable when it is a flex sibling. */
  variant?: "inline" | "panel" | "sheet";
  /** Optional action/content rendered below the paged session list. */
  footer?: ReactNode;
}

/**
 * Human-readable name for the open selection, in stage order.
 *
 * A single theme reads as one name; a link reads as "outcome theme → sentiment
 * theme", which is the phrasing on the diagram that was just clicked.
 */
export function selectionHeading(selection: InsightsSelection): string {
  if (selection.themes.length === 0 && !selection.questions?.length) {
    return "Selected sessions";
  }
  const order: Record<string, number> = {
    goal: 0,
    behavior: 1,
    outcome: 2,
    sentiment: 3,
  };
  const themes = [...selection.themes]
    .sort((a, b) => (order[a.dimension] ?? 9) - (order[b.dimension] ?? 9))
    .map((theme) => theme.label ?? theme.dimension);
  // Question columns sit to the right of the four themed ones, so their names
  // follow in the heading for the same reason: it reads as the path clicked.
  const questions = (selection.questions ?? []).map(
    (question) => question.label ?? (question.value ? "Yes" : "No"),
  );
  return [...themes, ...questions].join(" · ");
}

/**
 * Identity of everything the paged request depends on: the scope, the
 * selection, and the other active facet chips.
 *
 * The filters belong in the key because they are part of the query — and since
 * the selection's own chips live in that filter, they are covered by the same
 * sort. Keying on the selection alone means changing an unrelated chip while a
 * drill-down is open keeps the old cursor and the already-accumulated rows, so
 * the list would show sessions the current filter excludes and would start from
 * page two of a set that no longer exists.
 */
function requestKeyOf(
  scope: InsightsScope,
  selection: InsightsSelection | null,
  filter: UsageFilterState,
): string | null {
  if (
    !selection ||
    (selection.themes.length === 0 && !selection.questions?.length)
  ) {
    return null;
  }
  const scopeKey =
    scope.kind === "swarm"
      ? `swarm:${scope.projectId}:${(scope.journeyRunIds ?? []).join(",")}`
      : scope.kind === "benchmark"
        ? `benchmark:${scope.benchmarkRunId}`
        : `scenario:${scope.scenarioId}`;
  // Chip order is not semantically meaningful, so sort for a stable key.
  const chips = filter.chips.map(chipKey).sort().join(",");
  // The selection is keyed EXPLICITLY rather than relied on to show up in
  // `filter`. It normally does — the panel puts its chips there — but a caller
  // that does not would silently keep the previous selection's cursor and page
  // two of a set that no longer exists.
  const selected = selectionChips(selection).map(chipKey).sort().join(",");
  return [scopeKey, filter.preset, chips, selected].join("|");
}

type PagingState = {
  requestKey: string | null;
  before?: number;
  rows: DrilldownRow[];
  /**
   * Last known values from a settled query. Advancing the cursor makes the
   * subscription return `undefined` again, and without these the header would
   * flip back to "Loading…" and the pager would vanish from under the cursor on
   * every click. Replaced only when fresh data arrives.
   */
  lastTotal?: number;
  lastTotalTruncated?: boolean;
  lastNextBefore?: number | null;
};

/**
 * The pager's cursor for this render.
 *
 * NOT a `??` chain over the live value: a settled page reports "no more rows"
 * AS `nextBefore: null`, so coalescing on null would fall back to the previous
 * page's cursor and keep rendering "Load more" for a paint after the set is
 * exhausted — the settled null is an answer, not a gap. The last settled cursor
 * is a fallback only while the next page is in flight (live result undefined).
 */
export function resolveNextBefore(
  live: { nextBefore: number | null } | undefined,
  lastSettled: number | null | undefined,
): number | null {
  return live !== undefined ? live.nextBefore : lastSettled ?? null;
}

export function GoalOutcomeDrilldown({
  scope,
  selection,
  filter,
  onClose,
  onOpenSession,
  variant = "inline",
  footer,
}: GoalOutcomeDrilldownProps) {
  const open = selection !== null && !isEmptySelection(selection);
  const requestKey = requestKeyOf(scope, open ? selection : null, filter);

  // Cursor + accumulated pages, stored TOGETHER WITH the request they belong to.
  // Resetting in an effect instead would leave one render where the query runs
  // with the new request but the previous one's cursor, and the accumulate
  // effect could merge the old rows into the new list.
  const [paging, setPaging] = useState<PagingState>({
    requestKey: null,
    rows: [],
  });
  const [preview, setPreview] = useState<{
    requestKey: string | null;
    sessionId: string | null;
  }>({ requestKey: null, sessionId: null });

  // React's documented "adjust state when props change" pattern: reset during
  // render, conditionally, so the reset is visible to the query below on this
  // very render rather than one render late.
  const active: PagingState =
    paging.requestKey === requestKey
      ? paging
      : { requestKey, before: undefined, rows: [] };
  if (paging.requestKey !== requestKey) {
    setPaging(active);
  }
  const previewSessionId =
    preview.requestKey === requestKey ? preview.sessionId : null;
  if (preview.requestKey !== requestKey && preview.sessionId !== null) {
    setPreview({ requestKey, sessionId: null });
  }

  const { drilldown, isLoading } = useGoalOutcomeDrilldown({
    scope,
    // Absent for a behavior/outcome/sentiment selection; the server narrows by
    // chips alone in that case.
    clusterId:
      selection?.themes.find((theme) => theme.dimension === "goal")
        ?.clusterId ?? null,
    // Every other axis narrows through the selection's chips, which are already
    // in `filter` — the same way the Sessions list and the topic map read them.
    outcome: undefined,
    filters: filter,
    limit: PAGE_SIZE,
    before: active.before,
    enabled: open,
  });

  useEffect(() => {
    if (!drilldown) return;
    setPaging((prev) => {
      // A result that arrives after the request changed belongs to neither
      // list; drop it rather than appending it to the wrong one.
      if (prev.requestKey !== requestKey) return prev;
      const seen = new Set(prev.rows.map((row) => row._id));
      const fresh = drilldown.sessions.filter((row) => !seen.has(row._id));
      return {
        ...prev,
        rows: fresh.length === 0 ? prev.rows : [...prev.rows, ...fresh],
        lastTotal: drilldown.total,
        lastTotalTruncated: drilldown.totalTruncated,
        lastNextBefore: drilldown.nextBefore,
      };
    });
  }, [requestKey, drilldown]);

  const rows = active.rows;
  // Prefer live data; fall back to the last settled values so paging does not
  // blank the header and the pager mid-click.
  const total = drilldown?.total ?? active.lastTotal;
  const totalTruncated =
    drilldown?.totalTruncated ?? active.lastTotalTruncated ?? false;
  const nextBefore = resolveNextBefore(drilldown, active.lastNextBefore);
  const showEmpty = !isLoading && drilldown !== undefined && rows.length === 0;
  const countLabel =
    total === undefined
      ? "Loading sessions…"
      : `${total.toLocaleString()}${totalTruncated ? "+" : ""} session${
          total === 1 ? "" : "s"
        } in this selection`;

  const sessionList =
    rows.length === 0 ? null : (
      <div
        className={cn(
          caseListCardClassName,
          variant === "inline"
            ? "overflow-hidden"
            : "min-h-0 flex-1 overflow-hidden",
        )}
      >
        <CaseListColumnHeaders
          firstColumnLabel="Session"
          secondColumnLabel="Active"
        />
        <ul
          className={
            variant === "inline"
              ? "divide-y divide-border/40"
              : "min-h-0 flex-1 overflow-y-auto divide-y divide-border/40"
          }
        >
        {rows.map((session) => (
          <li key={session._id}>
            <DrilldownSessionRow
              session={session}
              onOpen={(sessionId) =>
                setPreview({ requestKey, sessionId })
              }
            />
          </li>
        ))}
        </ul>
      </div>
    );

  const truncatedNote = totalTruncated ? (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning-foreground"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        The count above stops at the scan limit; this selection has at least
        that many sessions.
      </span>
    </div>
  ) : null;

  const pager =
    nextBefore != null ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() =>
          setPaging((prev) =>
            prev.requestKey === requestKey
              ? { ...prev, before: nextBefore ?? undefined }
              : prev,
          )
        }
      >
        Load {PAGE_SIZE} more
      </Button>
    ) : null;

  const emptyNote = showEmpty ? (
    <p className="text-[11px] text-muted-foreground">
      No sessions match this selection with the current filters.
    </p>
  ) : null;

  const previewSession = previewSessionId
    ? (rows.find((row) => row._id === previewSessionId) ?? null)
    : null;
  const previewTitle =
    previewSession?.firstMessagePreview?.trim() || "(no preview)";
  const previewMeta = previewSession ? sessionRowMeta(previewSession) : null;

  const closePreview = () => setPreview({ requestKey, sessionId: null });

  const openSessionsAction =
    previewSessionId && onOpenSession ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onOpenSession(previewSessionId)}
      >
        Open in Sessions tab →
      </Button>
    ) : (
      footer
    );

  const sessionPreview = previewSessionId ? (
    <>
      <EvalInspectHeader
        crumb={selection ? selectionHeading(selection) : "Selected sessions"}
        onBack={closePreview}
        backAriaLabel="Back to selected sessions"
        title={previewTitle}
        badge={
          previewSession?.outcome ? (
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {previewSession.outcome}
            </span>
          ) : null
        }
        description={[
          previewSession?.lastActivityAt
            ? formatRelativeTime(previewSession.lastActivityAt)
            : null,
          previewMeta,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={openSessionsAction}
      />
      <EvalInspectBody fill>
        <div
          className="flex min-h-0 flex-1 flex-col"
          data-testid="goal-outcome-session-preview"
        >
          <ShareUsageThreadDetail
            threadId={previewSessionId}
            fadeScrollEdges
            hideHeader
          />
        </div>
      </EvalInspectBody>
    </>
  ) : null;

  if (variant === "sheet") {
    return (
      <EvalInspectSheet
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            closePreview();
            onClose();
          }
        }}
      >
        {open && selection ? (
          previewSession ? (
            sessionPreview
          ) : (
            <>
              <EvalInspectHeader
                title={selectionHeading(selection)}
                description={countLabel}
                actions={openSessionsAction}
              />
              <EvalInspectBody>
                {truncatedNote}
                {sessionList}
                {pager}
                {emptyNote}
              </EvalInspectBody>
            </>
          )
        ) : null}
      </EvalInspectSheet>
    );
  }

  if (!open || !selection) return null;

  return (
    <>
      <div
        className={
          variant === "panel"
            ? "flex h-full min-h-0 flex-col gap-2 px-4 py-3"
            : "flex flex-col gap-2 border-b bg-muted/20 px-5 py-4"
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium">
              {selectionHeading(selection)}
            </h3>
            <p className="text-[11px] text-muted-foreground">{countLabel}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close selection drill-down"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {truncatedNote}
        {sessionList}
        {pager}
        {footer}
        {emptyNote}
      </div>
      <EvalInspectSheet
        open={previewSession !== null}
        onOpenChange={(next) => {
          if (!next) closePreview();
        }}
      >
        {sessionPreview}
      </EvalInspectSheet>
    </>
  );
}
