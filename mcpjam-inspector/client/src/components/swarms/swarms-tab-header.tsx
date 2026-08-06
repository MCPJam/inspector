import { Button } from "@mcpjam/design-system/button";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";

export type SwarmViewMode = "overview" | "journeys" | "sessions";

export type SwarmViewOption = {
  value: SwarmViewMode;
  label: string;
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
      className="relative shrink-0 border-b border-border/40 px-8 py-2.5"
      data-testid="swarms-tab-header-chrome"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="shrink-0 text-xl font-bold tracking-tight text-foreground">
            Swarm
          </h1>
          <div
            className="hidden h-4 w-px shrink-0 bg-border/60 sm:block"
            aria-hidden="true"
          />
          <ViewModeSelector
            value={viewMode}
            ariaLabel="Swarm view"
            indicatorId="swarms-tab"
            onChange={onViewModeChange}
            options={viewOptions}
            className="min-w-0 justify-start md:w-auto [&_button]:min-h-9 [&_button]:px-3 [&_button]:py-1.5 [&_button]:text-sm sm:[&_button]:min-h-9 sm:[&_button]:px-3.5 sm:[&_button]:text-sm md:[&_button]:min-h-9 lg:[&_button]:px-4"
          />
        </div>
        <Button
          type="button"
          size="sm"
          className="shrink-0 rounded-lg px-4 font-medium"
          disabled={creatingSwarm || !projectId}
          onClick={onNewSwarm}
        >
          New swarm
        </Button>
      </div>
    </div>
  );
}
