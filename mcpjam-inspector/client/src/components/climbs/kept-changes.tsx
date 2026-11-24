import type { PlatformClimbStopped } from "@mcpjam/sdk/platform";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
import { Card } from "@mcpjam/design-system/card";
import { COPY } from "./climb-copy";
import { plural } from "./climb-format";
import type { Climb } from "./climb-types";
import { CopyButton } from "./copy-button";
import { changeTitle, submittedByLabel } from "./round-model";
import type { RoundChanges } from "./use-round-changes";

/** The kept changes in two groups, those that also helped on validation first, then the prompt for the agent that edits the server. */
export function KeptChanges({
  climb,
  stopped,
  changes,
}: {
  climb: Climb;
  stopped: PlatformClimbStopped;
  changes: RoundChanges;
}) {
  const groups = [
    [COPY.validationBetter, stopped.kept.filter((round) => round.validation === "better")],
    [COPY.noValidationMove, stopped.kept.filter((round) => round.validation !== "better")],
  ] as const;
  return (
    <>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {groups.map(([label, rounds]) => (
          <section key={label} aria-label={label}>
            <h2 className="mb-1 text-sm font-medium">{label}</h2>
            {rounds.length === 0 ? <p className="py-2 text-sm text-muted-foreground">None.</p> : null}
            {rounds.map((round) => {
              const summary = climb.rounds.find((candidate) => candidate.number === round.number);
              return (
                <div key={round.number} className="flex items-center gap-3 border-b border-border py-2 text-sm">
                  <span className="text-xs text-muted-foreground">{round.number}</span>
                  <span className="flex-1">{changeTitle(changes[round.number], round.number)}</span>
                  <span className="text-xs text-muted-foreground">{summary ? submittedByLabel(climb, summary) : ""}</span>
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <Card className="gap-3 px-4 py-4 shadow-none">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-medium">Prompt for your agent</h2>
          {stopped.kept.length > 0 ? <CopyButton text={stopped.prompt} /> : null}
        </div>
        {stopped.kept.length === 0 ? (
          <p className="text-sm text-muted-foreground">No round was kept, so there is nothing to apply.</p>
        ) : (
          <Accordion type="single" collapsible className="border-t border-border">
            <AccordionItem value="prompt">
              <AccordionTrigger className="py-2.5 text-sm hover:no-underline">
                {plural(stopped.kept.length, "kept change")}
              </AccordionTrigger>
              <AccordionContent>
                <pre className="whitespace-pre-wrap rounded-md border border-border bg-code-bg p-3 text-xs">
                  {stopped.prompt}
                </pre>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}
      </Card>
    </>
  );
}
