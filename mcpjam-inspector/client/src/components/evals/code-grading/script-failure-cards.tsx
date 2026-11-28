import type { NormalizedError } from "@mcpjam/sdk/browser";
import { ErrorCard } from "@/components/ui/error-card";
import {
  iterationScriptFailures,
  runScriptFailures,
  type ScriptFailure,
} from "./script-failures";

/**
 * One card per script that didn't pass: one message per box, each with the
 * way back to the scripts.
 */
export function ScriptFailureCards({
  failures,
  onEditScripts,
  defaultOpen = false,
}: {
  failures: readonly ScriptFailure[];
  /** Opens suite settings; absent where the suite can't be edited. */
  onEditScripts?: () => void;
  defaultOpen?: boolean;
}) {
  return (
    <>
      {failures.map((failure) => (
        <div key={failure.slot} data-testid={`script-failure-${failure.slot}`}>
          <ErrorCard
            error={failure.error}
            rawLabel={failure.rawLabel}
            density="card"
            defaultOpen={defaultOpen}
            {...(onEditScripts
              ? { action: { label: "Edit scripts", onClick: onEditScripts } }
              : {})}
          />
        </div>
      ))}
    </>
  );
}

/**
 * An iteration's error, as `IterationDetails` shows it. A failed setup
 * script replaces the generic Setup failed card, which would blame the
 * environment; a failed cleanup is its own warning beside any other error.
 */
export function IterationErrorCards({
  iteration,
  fallback,
  onEditScripts,
}: {
  iteration: { metadata?: Record<string, unknown> };
  fallback: NormalizedError | null;
  onEditScripts?: () => void;
}) {
  const failures = iterationScriptFailures(iteration);
  const setupFailed = failures.some((item) => item.slot === "iterationSetup");
  return (
    <>
      {fallback && !setupFailed ? <ErrorCard error={fallback} /> : null}
      <ScriptFailureCards failures={failures} onEditScripts={onEditScripts} />
    </>
  );
}

/**
 * The iteration page when a setup script failed (`setupScriptFailures`): the
 * agent never ran, so there is nothing to show but why.
 */
export function SetupFailedIteration({
  failures,
  onEditScripts,
}: {
  failures: readonly ScriptFailure[];
  onEditScripts?: () => void;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="iteration-setup-failed">
      <ScriptFailureCards
        failures={failures}
        onEditScripts={onEditScripts}
        defaultOpen
      />
      <p className="text-sm text-muted-foreground">
        The agent didn't run, so this iteration has no transcript or scorecard.
      </p>
    </div>
  );
}

/** Run setup and cleanup failures, on the run page. */
export function RunScriptNotices({
  run,
  onEditScripts,
}: {
  run: { scriptResults?: unknown };
  onEditScripts?: () => void;
}) {
  const failures = runScriptFailures(run);
  if (failures.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-2 px-5 pb-3"
      data-testid="run-script-notices"
    >
      <ScriptFailureCards failures={failures} onEditScripts={onEditScripts} />
    </div>
  );
}
