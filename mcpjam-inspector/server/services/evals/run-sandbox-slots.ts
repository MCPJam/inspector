/**
 * How many cases of one eval run may hold a box at once (PLB-579).
 *
 * A run starts all its cases together and each case runs its iterations one
 * at a time, so capping cases caps boxes. Past the cap the backend refuses the
 * run's next box (`at_capacity`, `resource: "run"`) and the capacity retry gives
 * up after about 90 seconds. Cases past it wait in the runner instead, before
 * any iteration clock starts.
 */
import { harnessOfHostConfig } from "./harness-admission";
import { needsEphemeralEvalSandbox } from "./needs-ephemeral-sandbox";

/** Mirrors mcpjam-backend `PER_RUN_SANDBOX_CONCURRENCY` (`convex/lib/ephemeralSandboxes.ts`). */
export const EVAL_RUN_SANDBOX_SLOTS = 4;

/** `undefined` when the run's iterations boot no box. */
export function caseConcurrencyForRun(args: {
  suiteHostConfig: Record<string, unknown> | null | undefined;
  environment: unknown;
  runId: unknown;
}): number | undefined {
  // The single-case surface has no per-run budget on the backend.
  if (args.runId == null) return undefined;
  const host = args.suiteHostConfig ?? {};
  const pinnedEnvironmentId = (
    args.environment as { computerEnvironmentId?: string } | undefined
  )?.computerEnvironmentId;
  const need = needsEphemeralEvalSandbox({
    pinnedEnvironmentId,
    harness: harnessOfHostConfig(host),
    builtInToolIds: Array.isArray(host.builtInToolIds)
      ? host.builtInToolIds.filter((id): id is string => typeof id === "string")
      : undefined,
    browserToolPolicy: host.browserToolPolicy,
    // The replica's hosted-browser verdict is left out: it can change during a
    // run, and assuming a browser can only over-limit.
    runId: args.runId,
  });
  if (!need.needed) return undefined;
  // A pinned image beside a desktop is two boxes, both counted against the run.
  return need.runtimeKind === "desktop-browser" && pinnedEnvironmentId
    ? EVAL_RUN_SANDBOX_SLOTS / 2
    : EVAL_RUN_SANDBOX_SLOTS;
}
