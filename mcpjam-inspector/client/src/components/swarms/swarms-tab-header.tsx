import { Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";

export type SwarmViewMode = "overview" | "journeys" | "sessions";

export type SwarmViewOption = {
  value: SwarmViewMode;
  label: string;
};

/**
 * Always shown, on every Swarm view — not just the empty state (BB-120). It is
 * the one line that explains what a swarm buys you, so it has to survive the
 * page having data.
 *
 * Personas gets its own line (BB-123): the tab is a library of reusable
 * personas, not a run surface, and the swarm pitch says nothing about it.
 */
const SWARM_SUBTITLE: Record<SwarmViewMode, string> = {
  overview:
    "No recruiting, no scheduling, no setup. Agents find what breaks in every client.",
  journeys: "The library of user personas you send into swarms.",
  sessions:
    "No recruiting, no scheduling, no setup. Agents find what breaks in every client.",
};

interface SwarmsTabHeaderProps {
  projectId: string | null;
  viewMode: SwarmViewMode;
  viewOptions: readonly SwarmViewOption[];
  onViewModeChange: (mode: SwarmViewMode) => void;
  onNewSwarm: () => void;
  creatingSwarm?: boolean;
}

export function SwarmsTabHeader({
  projectId,
  viewMode,
  viewOptions,
  onViewModeChange,
  onNewSwarm,
  creatingSwarm = false,
}: SwarmsTabHeaderProps) {
  return (
    <div
      className="relative shrink-0 border-b border-border/40 px-8 py-5"
      data-testid="swarms-tab-header-chrome"
    >
      {/* Title / CTA / body-copy stack, matching the User Testing header. */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="shrink-0 text-xl font-bold tracking-tight text-foreground">
          Swarm
        </h1>
        <Button
          type="button"
          size="sm"
          className="shrink-0 rounded-lg px-4 font-medium"
          disabled={creatingSwarm || !projectId}
          onClick={onNewSwarm}
        >
          <Plus className="mr-1.5 size-4" />
          Create new swarm
        </Button>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        {SWARM_SUBTITLE[viewMode]}
      </p>
      <ViewModeSelector
        value={viewMode}
        ariaLabel="Swarm view"
        indicatorId="swarms-tab"
        onChange={onViewModeChange}
        options={viewOptions}
        className="mt-4 min-w-0 justify-start md:w-auto [&_button]:min-h-9 [&_button]:px-3 [&_button]:py-1.5 [&_button]:text-sm sm:[&_button]:min-h-9 sm:[&_button]:px-3.5 sm:[&_button]:text-sm md:[&_button]:min-h-9 lg:[&_button]:px-4"
      />
    </div>
  );
}
