import { useMemo, type ReactNode } from "react";
import { AlertTriangle, Info, RefreshCw, Target } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  SIGNALS_VERSION_WITH_THEMES,
  type SankeyStage,
  type UsageBreakdown,
} from "@/hooks/useUsageInsights";
import { type InsightsSelection } from "@/hooks/scenario-usage-filters";
import { ClusterTuningControl } from "@/components/shared/usage-insights/ClusterTuningControl";
import { FlowSankeyDiagram } from "@/components/shared/usage-insights/flow-sankey-diagram";
import type { ClusterTuning } from "@/lib/cluster-tuning";
import {
  STAGE_ORDER,
  STAGE_TITLES,
  selectionForLink,
  selectionForNode,
} from "@/components/shared/usage-insights/insights-sankey";
import { cn } from "@/lib/utils";

interface SessionFlowSankeyProps {
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
  onApplyTuning?: (
    tuning: ClusterTuning,
    opts?: { force?: boolean },
  ) => void;
  /** False for scopes with no topic map, where link distance means nothing. */
  showLinkThreshold?: boolean;
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
      onClick={onRebuild}
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
  selection,
  onSelectNode,
  onSelectLink,
  onRebuild,
  rebuildBusy,
  onApplyTuning,
  showLinkThreshold,
  stageTitles,
  headerActions,
  fillHeight = false,
}: SessionFlowSankeyProps) {
  const sankey = breakdown?.sankey;
  const scan = breakdown?.scan;
  const signalsVersion = breakdown?.latestRun?.signalsVersion ?? null;
  const latestRun = breakdown?.latestRun ?? null;

  const titles = useMemo(
    () => ({ ...STAGE_TITLES, ...stageTitles }),
    [stageTitles],
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
  const tuningControl = onApplyTuning ? (
    <ClusterTuningControl
      value={latestRun?.tuning}
      onApply={onApplyTuning}
      busy={rebuildBusy}
      showLinkThreshold={showLinkThreshold}
      sessionCount={latestRun?.sessionCount}
    />
  ) : null;

  if (!breakdown) {
    return (
      <div
        className={cn(
          "flex items-center justify-between gap-3 text-xs text-muted-foreground",
          fillHeight ? "h-full px-0 py-6" : "px-5 py-10",
        )}
      >
        <span className="flex-1 text-center">Loading session flow…</span>
        <div className="flex items-center gap-2">
          {headerActions}
          {tuningControl}
        </div>
      </div>
    );
  }

  if (!sankey || sankey.nodes.length === 0) {
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-2 text-center",
          fillHeight ? "h-full justify-center px-0 py-6" : "px-5 py-10",
        )}
      >
        <Target className="h-6 w-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No session flow yet</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {signalsVersion === null
            ? "The last rebuild ran before session signals existed. Rebuild clusters to extract and group goals, behaviors, outcomes, and sentiment."
            : "Rebuild clusters once there are enough sessions to cluster."}
        </p>
        <div className="flex items-center gap-2">
          {headerActions}
          <RebuildButton
            onRebuild={onRebuild}
            busy={rebuildBusy}
            label="Rebuild clusters"
          />
          {tuningControl}
        </div>
      </div>
    );
  }

  const needsThemeRebuild =
    signalsVersion !== null && signalsVersion < SIGNALS_VERSION_WITH_THEMES;
  const analysisInFlight =
    latestRun?.status === "queued" || latestRun?.status === "running";
  // What the first column is called on this surface, for banner copy —
  // "journeys" on the swarm panel, "goals" on the scenario one.
  const goalNoun = (stageTitles?.goal ?? STAGE_TITLES.goal).toLowerCase();
  const selectedKeys = new Set(
    (selection?.themes ?? []).map(
      (theme) => `${theme.dimension}:${theme.clusterId}`,
    ),
  );

  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        fillHeight
          ? "h-full min-h-0 overflow-hidden px-0 py-1"
          : "border-b px-5 py-4",
      )}
      data-testid="scenario-insights-sankey"
      data-fill-height={fillHeight ? "true" : undefined}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
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
        {headerActions || tuningControl ? (
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            {headerActions}
            {tuningControl}
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
          exist at all). */}
      {analysisInFlight ? (
        <div
          role="status"
          className="flex shrink-0 items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"
        >
          <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
          <span>
            Analyzing sessions &mdash; grouping {goalNoun}s, behaviors,
            outcomes, and sentiment. This can take a few minutes.
          </span>
        </div>
      ) : latestRun === null ? (
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
      ) : needsThemeRebuild ? (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"
        >
          <span>
            These sessions were analyzed before every column was clustered, so
            only the goal column has themes.
          </span>
          <RebuildButton
            onRebuild={onRebuild}
            busy={rebuildBusy}
            label="Rebuild for themes"
          />
        </div>
      ) : null}

      <FlowSankeyDiagram
        sankey={sankey}
        stages={STAGE_ORDER}
        stageTitles={titles}
        stageColors={STAGE_COLOR}
        unitNoun="sessions"
        discordantHighlight
        selectedKeys={selectedKeys}
        onSelectNode={(node) => {
          const next = selectionForNode(node);
          if (next) onSelectNode(next);
        }}
        onSelectLink={(source, target) => {
          const next = selectionForLink(source, target);
          if (next) onSelectLink(next);
        }}
        isSelectable={(node) => selectionForNode(node) !== null}
        isLinkSelectable={(source, target) =>
          selectionForLink(source, target) !== null
        }
        ariaLabel="Session flow from goal through behavior and outcome to sentiment"
        fillHeight={fillHeight}
      />
    </div>
  );
}
