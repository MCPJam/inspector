import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import type { ClimbPaused } from "./climb-types";

/**
 * A paused climb says why, in the backend's own sentence, and offers the two
 * ways on: let MCPJam carry on from the last settled round, or pick the next
 * change yourself. Paused is never failed: nothing is lost.
 */
export function PausedBanner({
  paused,
  onContinue,
  onPickYourself,
}: {
  paused: ClimbPaused;
  onContinue: () => Promise<void>;
  onPickYourself: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const resume = async () => {
    setPending(true);
    setFailure(null);
    try {
      await onContinue();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The climb did not resume. Try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="border-b border-border px-6 py-4">
      <Alert variant="warning">
        <TriangleAlert />
        <AlertTitle>Paused</AlertTitle>
        <AlertDescription>
          <p className="text-foreground/80">{paused.reason}</p>
          {failure ? (
            <p role="alert" className="mt-2 text-destructive">
              {failure}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void resume()} disabled={pending}>
              Continue
            </Button>
            <Button size="sm" variant="outline" onClick={onPickYourself}>
              Pick the change yourself
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}
