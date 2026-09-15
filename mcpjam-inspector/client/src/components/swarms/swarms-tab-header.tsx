import { Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { LandingPageHeader } from "@/components/shared/landing-page-header";

export type SwarmViewMode = "overview" | "journeys" | "sessions";

export type SwarmViewOption = {
  value: SwarmViewMode;
  label: string;
};

/**
 * The one line that says what a swarm buys you, so it holds on every view and
 * on the empty state, the way Evaluate renders its own description (BB-236).
 */
const SWARM_HEADER_DESCRIPTION =
  "No recruiting, no scheduling, no setup. Agents find what breaks in every client.";

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
    <LandingPageHeader
      testId="swarms-tab-header-chrome"
      title="Swarm"
      description={SWARM_HEADER_DESCRIPTION}
      tabs={{
        value: viewMode,
        options: viewOptions,
        onChange: onViewModeChange,
        ariaLabel: "Swarm view",
        indicatorId: "swarms-tab",
      }}
      actions={
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
      }
    />
  );
}
