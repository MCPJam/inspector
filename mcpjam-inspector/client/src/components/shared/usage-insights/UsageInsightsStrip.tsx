import { useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import {
  chipKey,
  type UsageFilterChip,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";
import type {
  ClusterRunState,
  UsageBreakdown,
} from "@/hooks/useUsageInsights";
import { UsageBarCard, type BarDatum } from "./UsageBarCard";
import { UsageStackedBarCard, type StackedDatum } from "./UsageStackedBarCard";
import { UsageDonutPairCard } from "./UsageDonutPairCard";

interface UsageInsightsStripProps {
  breakdown: UsageBreakdown | null | undefined;
  filter: UsageFilterState;
  onToggleChip: (chip: UsageFilterChip) => void;
  onClearChip: (key: string) => void;
  onRebuild: () => void;
  rebuildBusy?: boolean;
}

function renderThemes(breakdown: UsageBreakdown | null | undefined): BarDatum[] {
  if (!breakdown) return [];
  return breakdown.themes.map((t) => ({
    key: t.clusterId,
    label: t.label,
    count: t.count,
  }));
}

function renderGeography(
  breakdown: UsageBreakdown | null | undefined,
): BarDatum[] {
  if (!breakdown) return [];
  return breakdown.geography.map((g) => ({
    key: g.key,
    label: g.label,
    count: g.count,
  }));
}

function renderUserSegment(
  breakdown: UsageBreakdown | null | undefined,
): StackedDatum[] {
  if (!breakdown) return [];
  return breakdown.userBreakdown.map((u) => ({
    key: u.segment,
    label: u.segment,
    positive: u.positive,
    neutral: u.neutral,
    negative: u.negative,
    none: u.none,
  }));
}

function rebuildButtonLabel(run: ClusterRunState | null | undefined): string {
  if (!run) return "Rebuild insights";
  if (run.isStale) return "Rebuild insights";
  switch (run.status) {
    case "queued":
      return "Queued…";
    case "running":
      return "Running…";
    case "failed":
      return "Retry rebuild";
    default:
      return "Rebuild insights";
  }
}

function rebuildDisabled(run: ClusterRunState | null | undefined): boolean {
  if (!run) return false;
  if (run.isStale) return false;
  return run.status === "queued" || run.status === "running";
}

export function UsageInsightsStrip({
  breakdown,
  filter,
  onToggleChip,
  onClearChip,
  onRebuild,
  rebuildBusy,
}: UsageInsightsStripProps) {
  const [open, setOpen] = useState(true);

  const latestRun = breakdown?.latestRun ?? null;
  const themes = renderThemes(breakdown);
  const geography = renderGeography(breakdown);
  const userSegment = renderUserSegment(breakdown);
  const devices: BarDatum[] = breakdown?.deviceBreakdown ?? [];
  const languages: BarDatum[] = breakdown?.languageBreakdown ?? [];

  const hasThemes = themes.length > 0;
  const totalSessions = breakdown?.totalSessions ?? 0;

  const selectedClusterId = filter.chips.find(
    (c) => c.kind === "cluster",
  )?.clusterId;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b">
      <div className="flex items-center justify-between gap-2 px-5 py-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1">
            {open ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
            <span className="text-sm font-medium">Usage insights</span>
            <span className="text-xs text-muted-foreground">
              {totalSessions} sessions
            </span>
          </Button>
        </CollapsibleTrigger>
        <div className="flex items-center gap-2">
          {latestRun?.status === "failed" ? (
            <span className="text-xs text-destructive">
              Last rebuild failed
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={rebuildDisabled(latestRun) || rebuildBusy}
            onClick={onRebuild}
          >
            <RefreshCw
              className={`size-3 ${
                latestRun?.status === "running" && !latestRun.isStale
                  ? "animate-spin"
                  : ""
              }`}
            />
            {rebuildButtonLabel(latestRun)}
          </Button>
        </div>
      </div>

      {filter.chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 px-5 pb-2">
          {filter.chips.map((chip) => {
            const label =
              chip.kind === "cluster"
                ? (chip.label ?? "Cluster")
                : (chip.label ?? `${chip.key}: ${chip.value}`);
            const key = chipKey(chip);
            return (
              <button
                key={key}
                type="button"
                onClick={() => onClearChip(key)}
                className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs hover:bg-muted"
              >
                <span>{label}</span>
                <X className="size-3" />
              </button>
            );
          })}
        </div>
      ) : null}

      <CollapsibleContent>
        <div className="grid grid-cols-1 gap-3 px-5 pb-4 md:grid-cols-2 xl:grid-cols-4">
          <UsageBarCard
            title="Themes"
            description={
              !hasThemes && latestRun?.status === "done"
                ? "Not enough sessions to cluster yet"
                : undefined
            }
            data={themes.map((t) => ({
              ...t,
              isSelected: t.key === selectedClusterId,
            }))}
            onBarClick={(datum) => {
              onToggleChip({
                kind: "cluster",
                clusterId: datum.key,
                label: datum.label,
              });
            }}
            emptyState={
              latestRun?.status === "done"
                ? "Need at least 10 new sessions"
                : latestRun?.status === "running"
                  ? "Clustering in progress…"
                  : "Click rebuild to generate themes"
            }
          />

          <UsageBarCard
            title="Geography"
            description="By country (from request headers)"
            data={geography}
            onBarClick={(datum) => {
              onToggleChip({
                kind: "dimension",
                key: "geoCountry",
                value: datum.key,
                label: `Country · ${datum.label}`,
              });
            }}
            emptyState="No geography data captured"
          />

          <UsageStackedBarCard
            title="Users by feedback"
            description="Visitor segment × feedback"
            data={userSegment}
            onSegmentClick={(datum, bucket) =>
              onToggleChip({
                kind: "dimension",
                key: "feedbackBucket",
                value: bucket,
                label: `${datum.label} · ${bucket}`,
              })
            }
            emptyState="No visitor data yet"
          />

          <UsageDonutPairCard
            title="Device & language"
            leftLabel="Device"
            leftData={devices}
            rightLabel="Language"
            rightData={languages}
            onLeftSliceClick={(datum) =>
              onToggleChip({
                kind: "dimension",
                key: "deviceKind",
                value: datum.key,
                label: `Device · ${datum.label}`,
              })
            }
            onRightSliceClick={(datum) =>
              onToggleChip({
                kind: "dimension",
                key: "language",
                value: datum.key,
                label: `Language · ${datum.label}`,
              })
            }
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
