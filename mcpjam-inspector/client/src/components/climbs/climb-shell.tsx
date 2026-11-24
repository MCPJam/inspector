import type { ReactNode } from "react";
import { ClimbBar } from "./climb-bar";
import type { Climb } from "./climb-types";
import { PausedBanner } from "./paused-banner";
import { RoundsRail, type Selection } from "./rounds-rail";
import type { RoundChanges } from "./use-round-changes";

/**
 * The frame every climb view sits in: the bar, a paused banner when MCPJam
 * stopped picking, the rail of rounds, and the selected view beside it. On a
 * narrow window the rail goes above the view.
 */
export function ClimbShell({
  climb,
  changes,
  selection,
  onSelect,
  mockName,
  onOpenMock,
  onContinue,
  onStop,
  children,
}: {
  climb: Climb;
  changes: RoundChanges;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  mockName: string;
  onOpenMock?: () => void;
  onContinue: () => Promise<void>;
  onStop: () => Promise<void>;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-col" data-testid="climb-shell">
      {climb.paused && climb.state !== "stopped" ? (
        <PausedBanner
          paused={climb.paused}
          onContinue={onContinue}
          onPickYourself={() => onSelect("new")}
        />
      ) : null}
      <ClimbBar climb={climb} mockName={mockName} onOpenMock={onOpenMock} onStop={onStop} />
      <div className="grid min-h-0 grid-cols-1 md:grid-cols-[296px_minmax(0,1fr)]">
        <RoundsRail climb={climb} changes={changes} selection={selection} onSelect={onSelect} />
        <main className="min-w-0 p-6">{children}</main>
      </div>
    </div>
  );
}
