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
      // Hidden while the list is empty (REEV-6, Vig in review): the empty
      // state has its own centred button, and two create buttons on one
      // screen is duplication. It must COME BACK once there are swarms to
      // list, because then there is no empty state to borrow a button from.
      //
      // `undefined` rather than `null`, so `LandingPageHeader` sees no action
      // at all rather than an empty slot to lay out.
      actions={
        showCreate ? (
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
        ) : undefined
      }
    />
  );
}
