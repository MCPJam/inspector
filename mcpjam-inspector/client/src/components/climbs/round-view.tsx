import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { decideRound, getClimbRound } from "@/lib/apis/climbs-api";
import { COPY } from "./climb-copy";
import type { Climb } from "./climb-types";
import { ChangeDisclosure } from "./change-disclosure";
import { DecisionDialog } from "./decision-dialog";
import { EnvironmentCell } from "./environment-cell";
import { PickerTranscript } from "./picker-transcript";
import { ResultBadge } from "./result-badge";
import { ResultTable } from "./result-table";
import { RunningView } from "./running-view";
import { changeTitle, roundResult, submittedByLabel } from "./round-model";
import { verdictSentence } from "./round-verdict";
import { useAsyncRead } from "./use-async-read";
import type { RoundChanges } from "./use-round-changes";

const POLL_MS = 5_000;

/**
 * One round: what it changed, the verdict in a sentence, each environment's
 * numbers against the noise, the rule in words, and the transcripts side by
 * side. A round that is running shows its progress and refreshes itself.
 */
export function RoundView({
  climb,
  roundNumber,
  changes,
  labels,
  onChanged,
}: {
  climb: Climb;
  roundNumber: number;
  changes: RoundChanges;
  labels: Record<string, string>;
  onChanged: () => void;
}) {
  const summary = climb.rounds.find((round) => round.number === roundNumber);
  const read = useAsyncRead(
    (signal) => getClimbRound({ projectId: climb.projectId, climbId: climb.climbId, roundNumber }, signal),
    `${climb.climbId}:${roundNumber}:${summary?.status}`,
    { pollMs: (round) => (round && round.status !== "running" ? null : POLL_MS) },
  );
  const [deciding, setDeciding] = useState<"kept" | "reverted" | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  const round = read.data;
  if (!summary) return <p className="text-sm text-muted-foreground">This round no longer exists.</p>;
  const title = changeTitle(changes[roundNumber], roundNumber);
  const by = submittedByLabel(climb, summary);
  const eyebrow = `Round ${roundNumber} · ${by}`;
  if (roundResult(summary) === "running") {
    return (
      <RunningView
        eyebrow={eyebrow}
        title={title}
        climbId={climb.climbId}
        unitKey={`round:${roundNumber}`}
        labels={labels}
        note="Stop the climb to cancel this round."
      />
    );
  }
  if (!round) {
    return read.error ? (
      <Alert variant="destructive">
        <AlertTitle>The round did not load</AlertTitle>
        <AlertDescription>
          <p>{read.error instanceof Error ? read.error.message : "Try again."}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={read.reload}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    ) : (
      <p className="text-sm text-muted-foreground" role="status">
        Loading the round.
      </p>
    );
  }

  const result = roundResult(round);
  const { lead, rest } = verdictSentence(round, {
    labels,
    measure: climb.measure,
    serverName: climb.serverName,
  });
  const undecided = result === "undecided";
  const decide = async (decision: "kept" | "reverted", reason: string) => {
    await decideRound({ projectId: climb.projectId, climbId: climb.climbId, roundNumber, decision, reason });
    onChanged();
    read.reload();
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">
            {eyebrow}
            {summary.pickerChatSessionId ? (
              <>
                {" · "}
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => setTranscriptOpen(true)}
                >
                  {COPY.transcriptLink}
                </button>
              </>
            ) : null}
          </div>
          <h2 className="text-lg font-semibold leading-snug tracking-tight">{title}</h2>
        </div>
        <ResultBadge result={result} />
      </div>

      {undecided ? (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>Not decided</AlertTitle>
          <AlertDescription>
            <p className="text-foreground/80">{rest}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setDeciding("kept")}>
                Keep it
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDeciding("reverted")}>
                Revert it
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-3xl text-sm">
            <span className="font-medium">{lead} </span>
            {rest}
          </p>
          <div className="flex items-center gap-2">
            {result === "kept" ? (
              <Badge
                variant="outline"
                className="font-normal"
                title={round.validation === "better" ? undefined : COPY.withinNoise}
              >
                {round.validation === "better" ? COPY.validationBetter : COPY.noValidationMove}
              </Badge>
            ) : null}
            {result === "kept" || result === "reverted" ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setDeciding(result === "kept" ? "reverted" : "kept")}
              >
                {result === "kept" ? "Revert it" : "Keep it"}
              </Button>
            ) : null}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {climb.environmentIds.map((id) => (
          <EnvironmentCell
            key={id}
            name={labels[id] ?? "Environment"}
            env={round.environments.find((env) => env.environmentId === id)}
            measure={climb.measure}
          />
        ))}
      </div>

      <Accordion type="multiple" className="border-t border-border">
        <AccordionItem value="change">
          <AccordionTrigger className="py-3 text-sm hover:no-underline">The change</AccordionTrigger>
          <AccordionContent className="pb-4">
            <ChangeDisclosure changes={changes[roundNumber]} />
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="result">
          <AccordionTrigger className="py-3 text-sm hover:no-underline">Result by environment</AccordionTrigger>
          <AccordionContent className="pb-4">
            <ResultTable
              environments={round.environments}
              labels={labels}
              measure={climb.measure}
              minImprovementBps={climb.minImprovementBps}
            />
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <DecisionDialog decision={deciding} onClose={() => setDeciding(null)} onDecide={decide} />
      {summary.pickerChatSessionId ? (
        <PickerTranscript
          sessionId={summary.pickerChatSessionId}
          open={transcriptOpen}
          onOpenChange={setTranscriptOpen}
        />
      ) : null}
    </div>
  );
}
