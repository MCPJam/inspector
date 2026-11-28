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
 * why it needs one (or `null`) and the booking's arguments. The route starts the
 * booking from this right after setup when `MCPJAM_HARNESS_BOX_FIRST=1`; the
 * tools stage uses it otherwise.
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

/** `MCPJAM_HARNESS_BOX_FIRST=1`: book the Playground box right after setup; read per call. */
export function harnessBoxFirstEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCPJAM_HARNESS_BOX_FIRST === "1";
}
