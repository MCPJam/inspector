import { useMemo, type ReactNode } from "react";
import { AlertTriangle, Info, RefreshCw, Target } from "lucide-react";
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
} from "@/components/shared/usage-insights/insights-sankey";
import { cn } from "@/lib/utils";

export interface SessionFlowSankeyProps {
  questionHeaders?: Partial<Record<SankeyStage, ReactNode>>;
  questionCreate?: ReactNode;
  questionEditing?: boolean;
  breakdown: UsageBreakdown | null | undefined;
  /** Currently open selection, so its endpoints can read as selected. */
  selection: InsightsSelection | null;
  onSelectNode: (selection: InsightsSelection) => void;
  onSelectLink: (selection: InsightsSelection) => void;
  onRebuild: () => void;
  rebuildBusy: boolean;
  /**
   * Rebuild with explicit clustering settings. Omitted callers get no tuning
   * control at all — the header is shared with surfaces that only ever want
   * the plain rebuild affordance.
   */
  /**
   * This surface starts its own analysis, so a MISSING run means one is being
   * arranged rather than waiting to be asked for (BB-196) — a working state,
   * not an "Analyze sessions" button.
   *
   * Off by default: it is a promise the owner has to keep, and a surface that
   * claimed it without queueing anything would spin forever.
   */
  analysisIsAutomatic?: boolean;
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
   * Opt into the page-scroll chrome: the diagram bleeds to its already-padded
   * owning container (no card padding, no `border-b`) and its header sticks as
   * the tall diagram scrolls past. This is the swarm Insights scroll opt-in and
   * is NOT implied by `!fillHeight` — the plain embedded callers (BenchReport,
   * the explanatory opt-in) keep the card chrome.
   */
  scrollLayout?: boolean;
}

/**
 * Per-axis colour. The four columns are independent clusterings, and giving
 * each its own hue is what lets a ribbon read as "this theme flows into that
 * one" rather than as one undifferentiated mass.
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
const QUESTION_COLOR: ReadonlyArray<{ node: string; head: string }> = [
  { node: "#d89bb0", head: "#b05a78" },
  { node: "#d4bc7a", head: "#9a7d32" },
  { node: "#7eb8c0", head: "#3d7a84" },
];

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
  questionCreate,
  questionEditing,
  selection,
  onSelectNode,
  onSelectLink,
  onRebuild,
  rebuildBusy,
  stageTitles,
  headerActions,
  fillHeight = false,
  scrollLayout = false,
}: SessionFlowSankeyProps) {
  const sankey = breakdown?.sankey;
  const scan = breakdown?.scan;

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

  if (!sankey || sankey.nodes.length === 0) {
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-2 text-center",
          fillHeight
            ? "h-full justify-center px-0 py-6"
            : scrollLayout
            ? "px-0 py-10"
            : "px-5 py-10",
        )}
      >
        {analysisInFlight ? (
          <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground/60" />
        ) : (
          <Target className="h-6 w-6 text-muted-foreground/60" />
        )}
        <p className="text-sm font-medium">
          {analysisInFlight ? "Analyzing sessions…" : "No session flow yet"}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          {analysisInFlight
            ? `Grouping ${goalNoun}s, behaviors, outcomes, and sentiment. This can take a few minutes.`
            : "Sessions appear here as analysis completes."}
        </p>
        <div className="flex items-center gap-2">
          {headerActions}
          {/* No voluntary rebuild here (#5277). Analysis runs on its own as
              sessions settle; the one place to ask for a re-analysis is the
              freshness chip's popover, so this empty state does not grow a
              second door. */}
        </div>
      </div>
    );
  }

  const selectedKeys = new Set([
    ...(selection?.themes ?? []).map(
      (theme) => `${theme.dimension}:${theme.clusterId}`,
    ),
    ...(selection?.questions ?? []).map(
      (q) => `question:${q.questionId}:${q.value ? "yes" : "no"}`,
    ),
  ]);
  const stages = sankey?.stages?.map((stage) => stage.id) ?? STAGE_ORDER;
  // Hue by position in the catalog order the server sent, so a column keeps
  // its colour for as long as the question exists.
  const colors = {
    ...STAGE_COLOR,
    ...Object.fromEntries(
      stages
        .filter((stage) => stage.startsWith("question:"))
        .map((stage, index) => [
          stage,
          QUESTION_COLOR[index % QUESTION_COLOR.length],
        ]),
    ),
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        fillHeight
          ? "h-full min-h-0 overflow-hidden px-0 py-1"
          : scrollLayout
          ? // Scroll layout: the diagram bleeds to its already-padded owning
            // container (no extra px-5) and drops the card border-b, which
            // belonged to the old locked-viewport chrome.
            "px-0 py-1"
          : // Embedded in a document/opt-in card (BenchReport, the
            // explanatory opt-in): keep the padded, divided card chrome.
            "border-b px-5 py-4",
      )}
      data-testid="scenario-insights-sankey"
      data-fill-height={fillHeight ? "true" : undefined}
      data-fill-remaining={scrollLayout ? "true" : undefined}
    >
      <div
        className={cn(
          "flex shrink-0 flex-wrap items-center justify-between gap-2",
          // Keep the freshness chip + Session-flow/Clusters toggle + tuning
          // control reachable while the tall diagram scrolls past beneath it.
          scrollLayout && "sticky top-0 z-10 bg-background pb-2",
        )}
      >
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
              Each column is clustered on its own, so a session&rsquo;s behavior
              theme says nothing about which outcome theme it lands in &mdash;
              that is what the ribbons show. Names are generated from the
              sessions in each group rather than chosen from a fixed list, so
              they change as the sessions do.
            </TooltipContent>
          </Tooltip>
        </div>
        {headerActions ? (
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            {headerActions}
          </div>
        ) : null}
      </div>

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

      {/* One analysis banner at a time, most-live state first: a rebuild in
          flight beats advertising the button that starts one, and
          never-analyzed beats the old-signals nudge (which requires a run to
          exist at all). On a self-analyzing surface `analysisInFlight` absorbs
          a missing run, so the never-analyzed branch below is unreachable
          there but still serves the surfaces that wait to be asked. */}
      {analysisInFlight ? (
        <div
          role="status"
          className="flex shrink-0 items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"
        >
          <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
          <span>Analyzing sessions…</span>
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
        headerContent={questionHeaders}
        headerTrailing={questionCreate}
        headerHeight={
          questionEditing
            ? 160
            : questionCreate || questionHeaders
            ? 38
            : undefined
        }
        unitNoun="sessions"
        discordantHighlight
        selectedKeys={selectedKeys}
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
