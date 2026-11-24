import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import { stopClimb } from "@/lib/apis/climbs-api";
import { ConfirmationSection } from "./confirmation-section";
import type { Climb } from "./climb-types";
import { KeptChanges } from "./kept-changes";
import { ResultsSection } from "./results-section";
import { useAsyncRead } from "./use-async-read";
import { VerifySection } from "./verify-section";
import type { RoundChanges } from "./use-round-changes";

/**
 * What a stopped climb showed. The summary and the prompt come from
 * `stop_climb`, which can be asked again for a climb that has stopped: it
 * changes nothing and answers the same.
 */
export function StoppedSummary({
  climb,
  labels,
  suiteName,
  changes,
  onChanged,
  onBack,
}: {
  climb: Climb;
  labels: Record<string, string>;
  suiteName: string;
  changes: RoundChanges;
  onChanged: () => void;
  onBack?: () => void;
}) {
  const read = useAsyncRead(
    (signal) => stopClimb({ projectId: climb.projectId, climbId: climb.climbId }, signal),
    `${climb.climbId}:${climb.updatedAt}`,
  );
  const stopped = read.data;
  return (
    <div className="mx-auto flex w-full max-w-[840px] flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs text-muted-foreground">
            Climb stopped · {climb.limits.roundsStarted === 1 ? "1 round" : `${climb.limits.roundsStarted} rounds`}
          </div>
          <h1 className="text-xl font-semibold tracking-tight">What this climb showed</h1>
          {stopped ? <p className="text-sm text-muted-foreground">It stopped because {stopped.summary.stoppedBecause}.</p> : null}
        </div>
        {onBack ? (
          <Button variant="outline" onClick={onBack}>
            Back to climbs
          </Button>
        ) : null}
      </div>
      {!stopped ? (
        read.error ? (
          <Alert variant="destructive">
            <AlertTitle>The summary did not load</AlertTitle>
            <AlertDescription>
              <p>{read.error instanceof Error ? read.error.message : "Try again."}</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={read.reload}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            Loading the summary.
          </p>
        )
      ) : (
        <>
          <ResultsSection summary={stopped.summary} labels={labels} />
          <ConfirmationSection
            climb={climb}
            summary={stopped.summary}
            labels={labels}
            suiteName={suiteName}
            onChanged={onChanged}
          />
          <KeptChanges climb={climb} stopped={stopped} changes={changes} />
          <VerifySection climb={climb} labels={labels} onChanged={onChanged} />
        </>
      )}
    </div>
  );
}
