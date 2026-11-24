import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import type { ClimbSummary, ConfirmationInterval } from "@mcpjam/sdk/climbs";
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
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
import { Card } from "@mcpjam/design-system/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import { confirmClimb } from "@/lib/apis/climbs-api";
import { AgentPromptDialog } from "./agent-prompt-dialog";
import { plural } from "./climb-format";
import type { Climb } from "./climb-types";
import { differenceText, intervalText, intervalVerdict, rateText } from "./stopped-model";
import { UnitProgress } from "./unit-progress";

type Quote = { cases: number; credits: number; lowerBound: boolean; usedBy: string[] };

function Result({ rows, notDecided, labels }: { rows: ConfirmationInterval[]; notDecided: string[]; labels: Record<string, string> }) {
  const holds = rows.filter((row) => intervalVerdict(row) === "holds");
  const noise = rows.filter((row) => intervalVerdict(row) === "within_noise");
  const name = (row: ConfirmationInterval) => labels[row.environmentId] ?? "An environment";
  return (
    <>
      <Card className="gap-0 overflow-hidden p-0 shadow-none">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Environment</TableHead>
              <TableHead>Baseline</TableHead>
              <TableHead>Best</TableHead>
              <TableHead>Change</TableHead>
              <TableHead>95% interval</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.environmentId}>
                <TableCell className="font-medium">{name(row)}</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">{rateText(row.passRate?.baselineBps)}</TableCell>
                <TableCell className="tabular-nums font-medium">{rateText(row.passRate?.bestBps)}</TableCell>
                <TableCell>{differenceText(row)}</TableCell>
                <TableCell className="text-muted-foreground">{intervalText(row)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <Alert>
        <Info />
        <AlertTitle>
          {holds.length > 0 ? `The gain holds on ${holds.map(name).join(", ")}.` : "No environment shows a gain on these cases."}
        </AlertTitle>
        <AlertDescription>
          <p className="text-foreground/80">
            {noise.length > 0 ? `On ${noise.map(name).join(", ")} it is within noise, so do not ship on it. ` : ""}
            {notDecided.length > 0 ? `${notDecided.map((id) => labels[id] ?? "An environment").join(", ")} could not be decided.` : ""}
          </p>
        </AlertDescription>
      </Alert>
    </>
  );
}

/**
 * The end of a climb is a confirmation on cases no round has run, once. A suite
 * too small to set any aside says plainly what the climb established instead.
 */
export function ConfirmationSection({
  climb,
  summary,
  labels,
  suiteName,
  onChanged,
}: {
  climb: Climb;
  summary: ClimbSummary;
  labels: Record<string, string>;
  suiteName: string;
  onChanged: () => void;
}) {
  const confirmation = summary.confirmation;
  const [quote, setQuote] = useState<Quote | null>(null);
  const [asking, setAsking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const canRun = confirmation.status === "not_run" || confirmation.status === "failed";

  useEffect(() => {
    if (!canRun) return;
    let cancelled = false;
    confirmClimb({ projectId: climb.projectId, climbId: climb.climbId, dryRun: true })
      .then((dry) => {
        if (cancelled) return;
        setQuote({
          cases: dry.confirmationCaseCount,
          credits: dry.estimate.creditsPerGroup * dry.estimate.groups,
          lowerBound: dry.estimate.lowerBound,
          usedBy: dry.confirmationCasesUsedBy,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : "The cost of the confirmation could not be read.");
      });
    return () => {
      cancelled = true;
    };
  }, [canRun, climb.climbId, climb.projectId]);

  const run = async () => {
    setPending(true);
    setFailure(null);
    try {
      await confirmClimb({ projectId: climb.projectId, climbId: climb.climbId });
      setAsking(false);
      onChanged();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The confirmation did not start. Try again.");
    } finally {
      setPending(false);
    }
  };

  if (confirmation.status === "no_cases") {
    return (
      <Alert>
        <Info />
        <AlertTitle>Not confirmed on new cases.</AlertTitle>
        <AlertDescription>
          <p className="text-foreground/80">{[...summary.established, ...summary.notEstablished].join(" ")}</p>
          <Button variant="link" className="mt-2 h-auto p-0 text-sm" onClick={() => setAdding(true)}>
            Add cases with your agent
          </Button>
          <AgentPromptDialog
            open={adding}
            onOpenChange={setAdding}
            title="Add cases with your agent"
            note="Copy this into your coding agent."
            prompt={`Use MCPJam to add eval cases to the suite "${suiteName}". Write 3 validation cases for the tools that have none, and check each one against ${climb.serverName} before you save it.`}
          />
        </AlertDescription>
      </Alert>
    );
  }
  if (confirmation.status === "settled") {
    return (
      <section className="flex flex-col gap-3" aria-label="Confirmation">
        <h2 className="text-sm font-medium">Confirmed on {plural(climb.groups.confirmation, "case")} no round has run</h2>
        <Result rows={confirmation.environments} notDecided={confirmation.notDecided} labels={labels} />
      </section>
    );
  }
  if (confirmation.status === "running") {
    return (
      <section className="flex flex-col gap-3" aria-label="Confirmation">
        <h2 className="text-sm font-medium">Confirming on cases no round has run</h2>
        <UnitProgress climbId={climb.climbId} unitKey={climb.confirmation?.unitKey} labels={labels} />
      </section>
    );
  }
  return (
    <Card className="gap-3 px-4 py-4 shadow-none" aria-label="Confirmation">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium">
            Confirm on {quote ? plural(quote.cases, "case") : "the cases"} no round has run
          </h2>
          <p className="text-sm text-muted-foreground">
            {confirmation.status === "failed"
              ? `The last attempt did not finish. ${confirmation.failureReason ?? ""}`.trim()
              : quote
                ? `Runs once. About ${quote.credits.toLocaleString("en-US")} credits${quote.lowerBound ? " or more" : ""}.`
                : "Reading the cost."}
          </p>
          {quote && quote.usedBy.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              An earlier climb already used some of these cases, so a second look at them is selection again.
            </p>
          ) : null}
          {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
        </div>
        <Button onClick={() => setAsking(true)} disabled={!quote || pending}>
          Confirm
        </Button>
      </div>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run the confirmation?</AlertDialogTitle>
            <AlertDialogDescription>
              It runs the baseline and the best server on {quote ? plural(quote.cases, "case") : "the cases"} no round has
              run, once. It spends about {quote?.credits.toLocaleString("en-US") ?? "some"} credits and cannot be run again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void run();
              }}
            >
              Run it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
