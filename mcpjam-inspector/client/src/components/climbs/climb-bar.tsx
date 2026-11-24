import { useState } from "react";
import { Square } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { Button } from "@mcpjam/design-system/button";
import { measureTitle } from "./climb-format";
import type { Climb } from "./climb-types";
import { MockBadge } from "./mock-badge";
import { bestSoFarLabel } from "./round-model";

/**
 * What the climb is for, the best so far, the mock it runs on, and the stop
 * button. Stopping asks first: it cancels a round in flight and cannot be undone.
 */
export function ClimbBar({
  climb,
  mockName,
  onOpenMock,
  onStop,
}: {
  climb: Climb;
  mockName: string;
  onOpenMock?: () => void;
  onStop: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const stop = async () => {
    setFailure(null);
    try {
      await onStop();
      setConfirming(false);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The climb did not stop. Try again.");
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <span>
          <span className="text-muted-foreground">Climb for </span>
          <span className="font-medium">{measureTitle(climb.measure)}</span>
        </span>
        <span>
          <span className="text-muted-foreground">Best so far </span>
          <span className="font-medium">{bestSoFarLabel(climb)}</span>
        </span>
        <button
          type="button"
          onClick={onOpenMock}
          disabled={!onOpenMock}
          aria-label="Open the mock server"
          className="flex items-center gap-1.5 rounded-md disabled:cursor-default"
        >
          <span className="font-medium">{mockName}</span>
          <MockBadge />
        </button>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={climb.state === "baselining" || climb.state === "stopped"}
        onClick={() => setConfirming(true)}
      >
        <Square aria-hidden /> Stop climb
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop this climb?</AlertDialogTitle>
            <AlertDialogDescription>
              A round that is running is cancelled, and a stopped climb cannot start again. You can
              still confirm and verify its result.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep climbing</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void stop();
              }}
            >
              Stop climb
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
