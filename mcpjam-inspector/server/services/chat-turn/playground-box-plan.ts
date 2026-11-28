import type { Context } from "hono";
import { playgroundHarnessBoxReason } from "../../utils/harness/playground-box.js";
import type { TurnTiming } from "../../utils/turn-timing.js";
import type { resolveManagedTurnSetup } from "./managed-setup.js";

type ManagedSetup = Extract<
  Awaited<ReturnType<typeof resolveManagedTurnSetup>>,
  { value: unknown }
>["value"];

/**
 * The Playground box a hosted harness turn takes, as far as setup decides it:
 * why it needs one (or `null`) and the booking's arguments. The managed turn
 * starts the booking from this right after setup; the tools stage uses it when
 * it is called without that booking.
 */
export function playgroundBoxPlan(args: {
  c: Context;
  bearerToken: string;
  timing: TurnTiming;
  setup: Pick<
    ManagedSetup,
    | "hostedBody"
    | "turnMode"
    | "resolvedExecution"
    | "harnessExecutionTarget"
    | "pinsEnvironment"
    | "environmentSpec"
  >;
}) {
  const { c, bearerToken, timing } = args;
  const { hostedBody, turnMode, resolvedExecution, harnessExecutionTarget, pinsEnvironment, environmentSpec } = args.setup;
  const reason = playgroundHarnessBoxReason({
    harnessId: resolvedExecution.harness,
    localExecution: Boolean(harnessExecutionTarget),
    isScenarioSession: turnMode === "recorded",
    comparePane: hostedBody.comparePane === true,
  });
  const playgroundEnvironmentId =
    pinsEnvironment || reason === "credential"
      ? environmentSpec?.environmentRef.environmentId
      : undefined;
  return {
    reason,
    args: {
      bearer: bearerToken,
      projectId: hostedBody.projectId,
      chatSessionId: hostedBody.chatSessionId,
      ...(playgroundEnvironmentId
        ? { projectEnvironmentId: playgroundEnvironmentId }
        : {}),
      harness: resolvedExecution.harness,
      signal: c.req.raw.signal as AbortSignal | undefined,
      timing,
    },
  };
}
