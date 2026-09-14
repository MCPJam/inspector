import { Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";

export type SwarmViewMode = "overview" | "journeys" | "sessions";

export type SwarmViewOption = {
  value: SwarmViewMode;
  label: string;
};

const TAB_CLASSNAME =
  "mt-0 w-auto min-w-0 shrink justify-start overflow-x-auto [&_button]:min-h-8 [&_button]:px-2.5 [&_button]:py-1 [&_button]:text-sm sm:[&_button]:min-h-8 sm:[&_button]:px-3 sm:[&_button]:text-sm md:[&_button]:min-h-8 lg:[&_button]:px-3.5";

interface SwarmsTabHeaderProps {
  projectId: string | null;
  viewMode: SwarmViewMode;
  viewOptions: readonly SwarmViewOption[];
  onViewModeChange: (mode: SwarmViewMode) => void;
  onNewSwarm: () => void;
  creatingSwarm?: boolean;
  /**
   * Whether to offer creation from the header at all.
   *
   * Off while the list is empty (REEV-6, Vig in review): the empty state has
   * its own centred button, and two create buttons on one screen is the
   * duplication he flagged. It comes BACK as soon as the list has anything in
   * it, because a member looking at real swarms still needs somewhere to make
   * the next one and the empty state's button is gone by then.
   *
   * Also off while the list is still loading, so the button does not appear
   * and then vanish for a project that turns out to be empty.
   */
  showCreate?: boolean;
}

export function SwarmsTabHeader({
  projectId,
  viewMode,
  viewOptions,
  onViewModeChange,
  onNewSwarm,
  creatingSwarm = false,
  showCreate = true,
}: SwarmsTabHeaderProps) {
  return (
    <div
      className="relative shrink-0 border-b border-border/40 px-8 py-3"
      data-testid="swarms-tab-header-chrome"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
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
            className={TAB_CLASSNAME}
          />
        </div>
        {showCreate ? (
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
        ) : null}
      </div>
    </div>
  );
}
