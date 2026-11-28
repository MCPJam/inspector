/**
 * Under the run sheet's clients: where each local harness client runs, and,
 * for one that can't run here, why and the one fix. A quiet line names the
 * clients that run on this machine (or in the cloud); each client that needs
 * something gets a row in one warning box, styled like "Before you run".
 */
import { Cloud, Laptop, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { LOCAL_RUNTIME_COPY } from "@/components/harness/local-runtime-copy";
import type {
  LocalEvalVenueRow,
  LocalEvalVenues,
} from "./use-local-harness-eval-venues";

function VenueLine({
  icon: Icon,
  label,
  rows,
}: {
  icon: typeof Laptop;
  label: string;
  rows: readonly LocalEvalVenueRow[];
}) {
  if (!rows.length) return null;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span>{label}</span>
      <span aria-hidden>·</span>
      <span className="text-foreground">{rows.map((row) => row.name).join(", ")}</span>
    </p>
  );
}

function VenueProblem({
  row,
  disabled,
  onSetUp,
  onRetry,
}: {
  row: LocalEvalVenueRow;
  disabled: boolean;
  onSetUp: () => void;
  onRetry: () => void;
}) {
  const { state } = row;
  if (state.kind === "setting-up") {
    return (
      <div className="space-y-1 py-3">
        <p className="flex flex-wrap items-center gap-x-1.5 font-medium">
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
          <span>Setting up</span>
          <span aria-hidden>·</span>
          <span>{row.name}</span>
        </p>
        {state.progress ? (
          <p className="pl-5 text-muted-foreground" aria-live="polite">
            {state.progress}
          </p>
        ) : null}
      </div>
    );
  }
  if (state.kind !== "refused" && state.kind !== "setup-failed") return null;
  const label =
    state.kind === "setup-failed"
      ? "Setup didn't finish"
      : state.fix === "retry"
        ? "Couldn't check"
        : "Can't run here";
  const fix =
    state.kind === "setup-failed" || (state.kind === "refused" && state.fix === "set-up") ? (
      <Button variant="secondary" size="sm" disabled={disabled} onClick={onSetUp}>
        {state.kind === "setup-failed" ? "Retry" : "Set up"}
      </Button>
    ) : state.fix === "retry" ? (
      <Button variant="secondary" size="sm" disabled={disabled} onClick={onRetry}>
        Retry
      </Button>
    ) : null;
  return (
    <div className="space-y-1.5 py-3">
      <p className="flex flex-wrap items-center gap-x-1.5 font-medium">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        <span>{label}</span>
        <span aria-hidden>·</span>
        <span>{row.name}</span>
      </p>
      <div className="flex items-center gap-3 pl-5">
        <div className="min-w-0 flex-1 space-y-1">
          <p>{state.message}</p>
          {state.kind === "refused" && state.fix === "set-up" ? (
            // What one click allows, as Add client says it: the click is the consent.
            <p className="text-muted-foreground">{LOCAL_RUNTIME_COPY[row.harnessId].setup}</p>
          ) : null}
        </div>
        {fix}
      </div>
    </div>
  );
}

export function SuiteRunVenues({
  venues,
  disabled,
}: {
  venues: LocalEvalVenues;
  disabled: boolean;
}) {
  const { rows } = venues;
  const problems = rows.filter(({ state }) =>
    ["refused", "setting-up", "setup-failed"].includes(state.kind),
  );
  if (!rows.length) return null;
  const local = rows.filter(({ state }) => state.kind === "local");
  const cloud = rows.filter(({ state }) => state.kind === "cloud");
  return (
    <section aria-label="Where each client runs" data-testid="suite-run-venues">
      {/* Mounted while the checks run, so a client found to run here or in the cloud is announced. */}
      <div aria-live="polite" className="space-y-2">
        <VenueLine icon={Laptop} label="Runs on this machine" rows={local} />
        <VenueLine icon={Cloud} label="Runs in the cloud" rows={cloud} />
      </div>
      {problems.length ? (
        <div
          role="status"
          className={`${local.length + cloud.length ? "mt-2 " : ""}divide-y divide-warning/30 rounded-lg border border-warning/45 bg-warning/10 px-3 text-xs`}
        >
          {problems.map((row) => (
            <VenueProblem
              key={row.harnessId}
              row={row}
              disabled={disabled}
              onSetUp={() => venues.setUp(row.harnessId)}
              onRetry={() => venues.check(row.harnessId)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
