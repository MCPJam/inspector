import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";

/**
 * A baseline that lost too many iterations leaves the climb waiting with
 * nothing running. The backend says why; running it again is the next step.
 */
export function BaselineFailed({
  reason,
  onRunAgain,
}: {
  reason: string;
  onRunAgain: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRunAgain();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The baseline did not start. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert variant="warning">
      <TriangleAlert />
      <AlertTitle>The baseline did not finish</AlertTitle>
      <AlertDescription>
        <p className="text-foreground/80">{reason}</p>
        {error ? <p className="mt-2 text-destructive">{error}</p> : null}
        <Button size="sm" variant="outline" className="mt-3" disabled={busy} onClick={run}>
          Run the baseline again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
