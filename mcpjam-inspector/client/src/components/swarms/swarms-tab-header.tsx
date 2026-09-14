import { Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";
import {
  PageHeaderShell,
  PAGE_HEADER_TAB_CLASSNAME,
} from "@/components/shared/page-header-shell";

export type SwarmViewMode = "overview" | "journeys" | "sessions";

export type SwarmViewOption = {
  value: SwarmViewMode;
  label: string;
};

export const SWARMS_HEADER_DESCRIPTION =
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
    <PageHeaderShell
      title="Swarm"
      description={SWARMS_HEADER_DESCRIPTION}
      className="px-8 py-3"
      testId="swarms-tab-header-chrome"
      tabs={
        <ViewModeSelector
          value={viewMode}
          ariaLabel="Swarm view"
          indicatorId="swarms-tab"
          onChange={onViewModeChange}
          options={viewOptions}
          className={PAGE_HEADER_TAB_CLASSNAME}
        />
      }
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
