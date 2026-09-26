import { useMemo, type ReactNode } from "react";
import { AlertTriangle, Clock, Info, Plus, RefreshCw, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  type SankeyStage,
  type UsageBreakdown,
} from "@/hooks/useUsageInsights";
import { type InsightsSelection } from "@/hooks/scenario-usage-filters";
import { FlowSankeyDiagram } from "@/components/shared/usage-insights/flow-sankey-diagram";
import {
  STAGE_ORDER,
  STAGE_TITLES,
  selectionForLink,
  selectionForNode,
  stageValueLabel,
} from "@/components/shared/usage-insights/insights-sankey";
import { useSankeyStageOrder } from "@/components/shared/usage-insights/sankey-stage-order";
import {
  analysisStatus,
  notRunNote,
  themesNote,
  type AnalysisStatus,
} from "@/components/shared/usage-insights/analysis-status";
import {
  AnalysisStatusPanel,
  AnalyzeNowForMembers,
} from "@/components/shared/usage-insights/analysis-status-panel";
import { cn } from "@/lib/utils";

export interface SessionFlowSankeyProps {
  questionHeaders?: Partial<Record<SankeyStage, ReactNode>>;
  questionEditing?: boolean;
  /** Opens the new-question dialog from the shared add-column menu. */
  onAddQuestion?: () => void;
  breakdown: UsageBreakdown | null | undefined;
  /** Currently open selection, so its endpoints can read as selected. */
  selection: InsightsSelection | null;
  onSelectNode: (selection: InsightsSelection) => void;
  onSelectLink: (selection: InsightsSelection) => void;
  onRebuild: () => void;
  rebuildBusy: boolean;
  /**
   * Analyze now: treat the scope's sessions as finished instead of waiting
   * out the idle window. Offered only where the empty state's reason
   * is one it can change (sessions still waiting, a failed pass). Omitted on
   * scopes that cannot settle sessions by hand, which then show the reason
   * alone.
   */
  onAnalyzeNow?: () => void;
  /** False for scopes with no topic map, where link distance means nothing. */
  showLinkThreshold?: boolean;
  goalGroupsByJourney?: boolean;
  /**
   * Per-stage header overrides. Defaults come from `STAGE_TITLES`; callers
   * can rename a column without forking the chart.
   */
  stageTitles?: Partial<Record<SankeyStage, string>>;
  /**
   * Extra controls rendered immediately before the tuning (Balanced) control
   * in the header row — e.g. a Session flow / Clusters toggle on swarms.
   */
  headerActions?: ReactNode;
  /**
   * Stretch into the parent height and re-lay the diagram to match the
   * available pane (run-detail Insights). Default keeps content-sized height
   * for scrollable surfaces like the scenario usage panel.
   */
  fillHeight?: boolean;
  /**
   * Opt into the leftover-pane chrome: the diagram bleeds to its already-
   * padded owning container (no card padding, no `border-b`) and fills that
   * parent, scrolling columns under sticky titles. This is the swarm
   * Insights opt-in and is NOT implied by `!fillHeight` — the plain
   * embedded callers (BenchReport, the explanatory opt-in) keep the card
   * chrome.
   */
  scrollLayout?: boolean;
  /**
   * localStorage slot for a dragged column permutation. Omit for an
   * ephemeral order that resets on remount (embedded / opt-in callers).
   */
  stageOrderKey?: string;
}

/**
 * Per-axis colour. The four columns are independent clusterings, and giving
 * each its own hue is what lets a ribbon read as "this theme flows into that
 * one" rather than as one undifferentiated mass.
 *
 * Question columns used to share `var(--foreground)`, so every Jev yes/no bar
 * — and the ribbon between two of them — painted as one black slab. They sit
 * in the same diagram-local palette as the four axes (not status tokens).
 */
const STAGE_COLOR: Record<SankeyStage, { node: string; head: string }> = {
  goal: { node: "#7fb3a0", head: "#2f8b76" },
  behavior: { node: "#8fb0d4", head: "#3d6fa6" },
  outcome: { node: "#e08356", head: "#c2552c" },
  sentiment: { node: "#bda2d8", head: "#7a5da3" },
};

/**
 * One hue per question column, for the same reason the four axes have one
 * each. Sharing `--foreground` across every question painted all of them, and
 * the ribbons between them, as a single dark slab — the paragraph above says
 * why that reads as one mass rather than as a flow.
 *
 * Three entries because the backend caps a scope at three questions. They are
 * literal hex like the four axes above: this is the diagram's own palette, not
 * a status vocabulary, and a role token would tie a column's identity to a
 * meaning it does not carry.
 */
const QUESTION_COLORS: ReadonlyArray<{ node: string; head: string }> = [
  { node: "#d89bb0", head: "#b05a78" },
  { node: "#d4bc7a", head: "#9a7d32" },
  { node: "#7eb8c0", head: "#3d7a84" },
];

function colorsForStages(
  stages: readonly SankeyStage[],
): Record<SankeyStage, { node: string; head: string }> {
  let questionIndex = 0;
  return {
    ...STAGE_COLOR,
    ...Object.fromEntries(
      stages
        .filter((stage) => stage.startsWith("question:"))
        .map((stage) => [
          stage,
          QUESTION_COLORS[questionIndex++ % QUESTION_COLORS.length],
        ]),
    ),
  };
}

function HideColumnButton({
  label,
  onHide,
}: {
  label: string;
  onHide: () => void;
}) {
  return (
    <button
      type="button"
      data-no-dnd
      aria-label={`Remove ${label} column`}
      className="shrink-0 text-muted-foreground opacity-0 hover:text-foreground focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
      onClick={onHide}
    >
      <X className="size-3" />
    </button>
  );
}

function CatalogColumnHeader({
  title,
  canHide,
  onHide,
}: {
  title: string;
  canHide: boolean;
  onHide: () => void;
}) {
  return (
    <div className="group flex items-center gap-1">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.13em]">
        {title}
      </span>
      {canHide ? <HideColumnButton label={title} onHide={onHide} /> : null}
    </div>
  );
}

function AddColumnTrailing({
  hidden,
  titles,
  onRestore,
  onAddQuestion,
}: {
  hidden: SankeyStage[];
  titles: Record<SankeyStage, string>;
  onRestore: (stage: SankeyStage) => void;
  onAddQuestion?: () => void;
}) {
  if (hidden.length === 0 && !onAddQuestion) return null;
  if (hidden.length === 0 && onAddQuestion) {
    return (
      <button
        type="button"
        data-no-dnd
        aria-label="Add question column"
        onClick={onAddQuestion}
        className="flex shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-4" />
      </button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-no-dnd
          aria-label="Add column"
          className="flex shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        {hidden.map((stage) => (
          <DropdownMenuItem key={stage} onSelect={() => onRestore(stage)}>
            {titles[stage]}
          </DropdownMenuItem>
        ))}
        {onAddQuestion ? (
          <DropdownMenuItem onSelect={() => onAddQuestion()}>
            Add question
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RebuildButton({
  onRebuild,
  busy,
  label,
}: {
  onRebuild: () => void;
  busy: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onRebuild()}
      disabled={busy}
      className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-muted/50 disabled:opacity-60"
    >
      <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} />
      {busy ? "Rebuilding…" : label}
    </button>
  );
}

/**
 * Session flow: one emergent theme per axis, four axes, ribbons for the
 * sessions shared between adjacent ones.
 *
 * Every label here is a cluster name the analysis produced — there is no fixed
 * vocabulary to render, which is why the behavior column can say "Guessed an id
 * after truncation" rather than picking from a list written in advance.
 */
export function SessionFlowSankey({
  breakdown,
  questionHeaders,
  questionEditing,
  onAddQuestion,
  selection,
  onSelectNode,
  onSelectLink,
  onRebuild,
  rebuildBusy,
  onAnalyzeNow,
  stageTitles,
  headerActions,
  fillHeight = false,
  scrollLayout = false,
  stageOrderKey,
}: SessionFlowSankeyProps) {
  const sankey = breakdown?.sankey;
  const scan = breakdown?.scan;
  // Canonical (catalog) order — colors stay pinned to a question's id, not
  // whichever slot it was dragged into.
  const rawStages = sankey?.stages?.map((stage) => stage.id) ?? STAGE_ORDER;
  const { stages, hidden, onReorder, onHide, onRestore } = useSankeyStageOrder(
    rawStages,
    stageOrderKey,
  );
  const colors = colorsForStages(rawStages);

  /**
   * Hoisted above the early returns: the empty-flow branch below needs it too.
   * Offering "Rebuild clusters" while a rebuild is already running was always
   * wrong there, and on a self-analyzing surface it is the whole bug.
   */
  const analysisInFlight = breakdown?.analysis
    ? breakdown.analysis.pending +
        breakdown.analysis.running -
        breakdown.analysis.deferred >
      0
    : false;
  // What the first column is called on this surface, for banner copy —
  // "journeys" on the swarm panel, "goals" on the scenario one.
  const goalNoun = (stageTitles?.goal ?? STAGE_TITLES.goal).toLowerCase();

  const titles = useMemo<Record<SankeyStage, string>>(
    () => ({
      ...STAGE_TITLES,
      ...Object.fromEntries(
        (sankey?.stages ?? []).map((stage) => [stage.id, stage.label]),
      ),
      ...stageTitles,
    }),
    [stageTitles, sankey?.stages],
  );

  const headerContent = useMemo(() => {
    const headers: Partial<Record<SankeyStage, ReactNode>> = {
      ...questionHeaders,
    };
    const canHide = stages.length > 1;
    for (const stage of stages) {
      if (headers[stage] || stage.startsWith("question:")) continue;
      headers[stage] = (
        <CatalogColumnHeader
          title={titles[stage]}
          canHide={canHide}
          onHide={() => onHide(stage)}
        />
      );
    }
    return headers;
  }, [onHide, questionHeaders, stages, titles]);

  const headerTrailing = (
    <AddColumnTrailing
      hidden={hidden}
      titles={titles}
      onRestore={onRestore}
      onAddQuestion={onAddQuestion}
    />
  );

  /**
   * The tuning control, rendered in EVERY state including the two that return
   * early below.
   *
   * A swarm that has never clustered is exactly when someone wants to choose
   * how it should cluster, so gating the settings behind "there is already a
   * flow to look at" hides them precisely when they are most useful. It seeds
   * from the defaults when there is no run to read.
   */
  if (!breakdown) {
    return (
      <div
        className={cn(
          "flex items-center justify-between gap-3 text-xs text-muted-foreground",
          fillHeight
            ? "h-full px-0 py-6"
            : scrollLayout
            ? "px-0 py-10"
            : "px-5 py-10",
        )}
      >
        <span className="flex-1 text-center">Loading session flow…</span>
        <div className="flex items-center gap-2">{headerActions}</div>
      </div>
    );
  }

  // Placeholders ("Analyzing", "Other / unclassified", "Sign in to analyze")
  // are not a flow: four such bars said nothing the reason could not say
  // better (prod, 2026-09-22). A surface that reports its analysis gets the
  // reason instead; one that waits to be asked keeps its diagram and banner.
  const hasContent =
    sankey?.nodes.some((node) => !node.key.startsWith("__")) ?? false;
  if (
    !sankey ||
    sankey.nodes.length === 0 ||
    (breakdown.analysis && !hasContent)
  ) {
    const status: AnalysisStatus = analysisStatus(
      breakdown.analysis,
      Date.now(),
    ) ?? {
      kind: analysisInFlight ? "analyzing" : "empty",
      title: analysisInFlight ? "Analyzing sessions…" : "No session flow yet",
      body: analysisInFlight
        ? `Grouping ${goalNoun}s, behaviors, outcomes, and sentiment.`
        : "Sessions appear here as analysis completes.",
    };
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-3",
          fillHeight
            ? "h-full justify-center px-0 py-6"
            : scrollLayout
            ? "px-0 py-10"
            : "px-5 py-10",
        )}
      >
        <AnalysisStatusPanel
          status={status}
          onAnalyzeNow={onAnalyzeNow}
          busy={rebuildBusy}
          testId="session-flow-status"
        />
        {/* The one voluntary action is Analyze now, and only where the reason
            is one it can change. Re-analysis is otherwise automatic (#5277). */}
        {headerActions ? (
          <div className="flex items-center gap-2">{headerActions}</div>
        ) : null}
      </div>
    );
  }

  // Drawn, but not finished: say what is still coming, in one line. The
  // provisional state is the common one for the first half hour of a study:
  // goal, behavior and sentiment are in, and the outcome column waits.
  const liveStatus = analysisStatus(breakdown.analysis, Date.now());
  const liveBanner =
    liveStatus &&
    (liveStatus.kind === "analyzing" ||
      liveStatus.kind === "waiting" ||
      liveStatus.kind === "deferred" ||
      liveStatus.kind === "provisional")
      ? liveStatus
      : null;
  const note = themesNote(breakdown.analysis);
  const notRunLine = notRunNote(breakdown.analysis);

  const selectedKeys = new Set([
    ...(selection?.themes ?? []).map(
      (theme) => `${theme.dimension}:${theme.clusterId}`,
    ),
    ...(selection?.questions ?? []).map(
      (q) => `question:${q.questionId}:${q.value ? "yes" : "no"}`,
    ),
  ]);

  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        fillHeight || scrollLayout
          ? "flex h-full min-h-0 flex-1 flex-col overflow-hidden px-0 py-1"
          : // Embedded in a document/opt-in card (BenchReport, the
            // explanatory opt-in): keep the padded, divided card chrome.
            "border-b px-5 py-4",
      )}
      data-testid="scenario-insights-sankey"
      data-fill-height={fillHeight ? "true" : undefined}
      data-fill-remaining={scrollLayout ? "true" : undefined}
    >
      {scan?.truncated ? (
        <div
          role="status"
          className="flex shrink-0 items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning-foreground"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Counts below cover the most recent {scan.matched.toLocaleString()}{" "}
            matching sessions, not the full history &mdash; the scan stops at{" "}
            {scan.maxSessions.toLocaleString()}. Older sessions are not
            included.
          </span>
        </div>
      ) : null}

      {/* One analysis banner at a time, most-live state first: work in
          flight (or waiting on its door, or held by the daily limit) beats
          advertising the button that starts one. The never-analyzed branch
          only serves surfaces that report no analysis and wait to be asked. */}
      {liveBanner ? (
        <div
          role="status"
          className="flex shrink-0 items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"
        >
          {liveBanner.kind === "analyzing" ? (
            <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1">
            <span className="font-medium text-foreground">
              {liveBanner.title}
            </span>{" "}
            {liveBanner.body}
          </span>
          {liveBanner.action === "analyze_now" && onAnalyzeNow ? (
            <AnalyzeNowForMembers onAnalyzeNow={onAnalyzeNow} busy={rebuildBusy} />
          ) : null}
        </div>
      ) : !breakdown?.analysis ? (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"
        >
          <span>
            These sessions haven&rsquo;t been analyzed yet &mdash; the flow
            fills in once analysis groups {goalNoun}s, behaviors, outcomes, and
            sentiment.
          </span>
          <RebuildButton
            onRebuild={onRebuild}
            busy={rebuildBusy}
            label="Analyze sessions"
          />
        </div>
      ) : null}

      <FlowSankeyDiagram
        sankey={sankey}
        stages={stages}
        stageTitles={titles}
        stageColors={colors}
        toolbar={
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 pb-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">Session flow</h3>
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="About the session flow"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  <p>Each column clusters on its own.</p>
                  <p>Ribbons connect neighboring columns.</p>
                </TooltipContent>
              </Tooltip>
              {note ? (
                <span
                  className="text-[11px] text-muted-foreground"
                  data-testid="session-flow-themes-note"
                >
                  {note}
                </span>
              ) : null}
              {notRunLine ? (
                <span
                  className="text-[11px] text-muted-foreground"
                  data-testid="session-flow-not-run-note"
                >
                  {notRunLine}
                </span>
              ) : null}
            </div>
            {headerActions ? (
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                {headerActions}
              </div>
            ) : null}
          </div>
        }
        headerContent={headerContent}
        headerTrailing={headerTrailing}
        headerHeight={38}
        onReorderStages={onReorder}
        reorderDisabled={questionEditing}
        unitNoun="sessions"
        discordantHighlight
        selectedKeys={selectedKeys}
        labelForNode={(node) => stageValueLabel(node, analysisInFlight)}
        onSelectNode={(node) => {
          const next = selectionForNode(node);
          if (next?.questions)
            next.questions = next.questions.map((q) => ({
              ...q,
              label: `${titles[node.stage]}: ${q.value ? "Yes" : "No"}`,
            }));
          if (next) onSelectNode(next);
        }}
        onSelectLink={(source, target) => {
          const next = selectionForLink(source, target);
          if (next?.questions)
            next.questions = next.questions.map((q) => ({
              ...q,
              label: `${titles[`question:${q.questionId}`]}: ${
                q.value ? "Yes" : "No"
              }`,
            }));
          if (next) onSelectLink(next);
        }}
        isSelectable={(node) => selectionForNode(node) !== null}
        isLinkSelectable={(source, target) =>
          selectionForLink(source, target) !== null
        }
        ariaLabel="Session flow from goal through behavior and outcome to sentiment"
        fillHeight={fillHeight}
        fillRemainingViewport={scrollLayout}
      />
    </div>
  );
}
