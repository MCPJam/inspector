import { Button } from "@mcpjam/design-system/button";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";

const SWARM_HEADER_DESCRIPTION =
  "We invent realistic users, drop them into the clients your users actually use, and report what breaks. Nothing to configure first.";

export type SwarmViewMode = "overview" | "journeys" | "sessions" | "insights";

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
      className="relative shrink-0 space-y-3 border-b border-border/40 px-8 py-4"
      data-testid="swarms-tab-header-chrome"
    >
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-xl font-bold tracking-tight text-foreground">
          Swarm
        </h1>
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

      <p className="min-w-0 text-sm leading-relaxed text-muted-foreground">
        {SWARM_HEADER_DESCRIPTION}
      </p>

      <ViewModeSelector
        value={viewMode}
        ariaLabel="Swarm view"
        onChange={onViewModeChange}
        options={viewOptions}
        className="justify-start md:w-auto"
      />
    </div>
  );
}
