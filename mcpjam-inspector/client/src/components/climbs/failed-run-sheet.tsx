import type { FailedRun } from "@mcpjam/sdk/climbs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import { useRunsIterations } from "../evals/use-runs-iterations";
import { PaneCard } from "./pane-card";

function Body({ run, environment }: { run: FailedRun; environment: string }) {
  const { byRun, isLoading } = useRunsIterations([run.runId]);
  const iteration = byRun.get(run.runId)?.find((candidate) => candidate._id === run.iterationId);
  return (
    <PaneCard
      height={520}
      pane={{ title: environment, sub: run.reason, iteration, loading: isLoading }}
    />
  );
}

/** One failed run behind a "Climb for" number, opened with its transcript. */
export function FailedRunSheet({
  run,
  environment,
  onClose,
}: {
  run: FailedRun | null;
  environment: string;
  onClose: () => void;
}) {
  return (
    <Sheet open={run !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-[640px] max-w-full flex-col gap-0 p-0">
        <SheetHeader>
          <SheetTitle>{run?.caseTitle ?? "A failed run"}</SheetTitle>
          <SheetDescription>{run ? `${environment} · steering case` : ""}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          {run ? <Body run={run} environment={environment} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
