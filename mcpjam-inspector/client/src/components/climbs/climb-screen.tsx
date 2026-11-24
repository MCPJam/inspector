import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import { continueClimb, getClimb, stopClimb } from "@/lib/apis/climbs-api";
import { ClimbShell } from "./climb-shell";
import type { Climb } from "./climb-types";
import { MockSheet } from "./mock-sheet";
import { NewRound } from "./new-round";
import { ReadyView } from "./ready-view";
import { defaultOptionId } from "./ready-model";
import { RoundView } from "./round-view";
import type { Selection } from "./rounds-rail";
import { RunningView } from "./running-view";
import { StoppedSummary } from "./stopped-summary";
import { useAsyncRead } from "./use-async-read";
import { useRoundChanges } from "./use-round-changes";

const POLL_MS = 5_000;

/** A climb is read again while anything of it is still moving: the baseline, a round, MCPJam's turn, or the end. */
function stillMoving(climb: Climb | undefined): boolean {
  if (!climb) return true;
  if (climb.state === "baselining" || climb.rounds.some((round) => round.status === "running")) return true;
  if (climb.step !== undefined && !climb.paused) return true;
  return climb.confirmation?.status === "running" || climb.verifications.some((run) => run.status === "running");
}

function firstSelection(climb: Climb): Selection {
  if (climb.state === "baselining" || climb.rounds.length === 0) return "base";
  return climb.rounds[climb.rounds.length - 1].number;
}

/**
 * One climb, from its baseline to its summary. It reads the climb and reads it
 * again while a baseline, a round or a confirmation runs, so each round shows as
 * it arrives and who submitted it.
 */
export function ClimbScreen({
  projectId,
  climbId,
  suiteName,
  labels,
  onBack,
}: {
  projectId: string;
  climbId: string;
  suiteName: string;
  labels: Record<string, string>;
  onBack: () => void;
}) {
  const read = useAsyncRead((signal) => getClimb({ projectId, climbId }, signal), `${projectId}:${climbId}`, {
    pollMs: (climb) => (stillMoving(climb) ? POLL_MS : null),
  });
  const climb = read.data;
  const changes = useRoundChanges(projectId, climb);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [optionId, setOptionId] = useState<string | undefined>();
  const [mockOpen, setMockOpen] = useState(false);
  const opened = useRef(false);

  // The first read picks where to land: the baseline, or the latest round.
  useEffect(() => {
    if (climb && !opened.current) {
      opened.current = true;
      setSelection(firstSelection(climb));
    }
  }, [climb]);
  const chosenOption = optionId ?? (climb ? defaultOptionId(climb) : undefined);

  if (!climb) {
    return read.error ? (
      <Alert variant="destructive" className="m-6 w-auto">
        <AlertTitle>The climb did not load</AlertTitle>
        <AlertDescription>
          <p>{read.error instanceof Error ? read.error.message : "Try again."}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" onClick={read.reload}>
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={onBack}>
              Back to climbs
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    ) : (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        Loading the climb.
      </p>
    );
  }

  if (climb.state === "stopped") {
    return (
      <div className="p-6">
        <StoppedSummary
          climb={climb}
          labels={labels}
          suiteName={suiteName}
          changes={changes}
          onChanged={read.reload}
          onBack={onBack}
        />
      </div>
    );
  }

  const current = selection ?? firstSelection(climb);
  const optionLabel = climb.climbFor?.find((option) => option.id === chosenOption)?.label ?? "Everything this server lets you change";
  const submitted = (roundNumber: number) => {
    read.reload();
    setSelection(roundNumber);
  };

  let main;
  if (current === "base") {
    main =
      climb.state === "baselining" ? (
        <RunningView
          title="Baseline"
          climbId={climb.climbId}
          unitKey={climb.activeUnitKey}
          labels={labels}
          note="The baseline runs every case twice in each environment. You can leave this page."
        />
      ) : (
        <ReadyView
          climb={climb}
          labels={labels}
          suiteName={suiteName}
          selected={chosenOption}
          onSelect={setOptionId}
          onNext={() => setSelection("new")}
          onChanged={read.reload}
        />
      );
  } else if (current === "new") {
    main =
      climb.state === "baselining" ? (
        <p className="text-sm text-muted-foreground">New rounds open once the baseline has settled.</p>
      ) : (
        <NewRound climb={climb} optionId={chosenOption} optionLabel={optionLabel} onSubmitted={submitted} />
      );
  } else {
    main = (
      <RoundView
        climb={climb}
        roundNumber={current}
        changes={changes}
        labels={labels}
        onChanged={read.reload}
      />
    );
  }

  return (
    <>
      <ClimbShell
        climb={climb}
        changes={changes}
        selection={current}
        onSelect={setSelection}
        mockName={`${climb.serverName} climb`}
        onOpenMock={climb.best?.serverId ? () => setMockOpen(true) : undefined}
        onContinue={async () => {
          await continueClimb({ projectId, climbId });
          read.reload();
        }}
        onStop={async () => {
          await stopClimb({ projectId, climbId });
          read.reload();
        }}
      >
        {main}
      </ClimbShell>
      <MockSheet
        projectId={projectId}
        mockId={climb.best?.serverId}
        name={`${climb.serverName} climb`}
        open={mockOpen}
        onOpenChange={setMockOpen}
      />
    </>
  );
}
