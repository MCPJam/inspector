/**
 * Prepare a new hosted chat's computer while its first message is typed.
 *
 * The first Send of a hosted Claude Code or Codex chat creates the
 * conversation's box and installs the agent before the model sees a byte.
 * This does those two things earlier, and nothing else: it boots the box
 * (`purpose: "prepare"`), claims it under the per-box reservation that fences
 * every turn's preparation, attaches through the pre-broker attach, and runs
 * the pnpm guard and the framework's bootstrap (a marker check, or the
 * install) for the agent's recipes.
 *
 * It never claims the conversation's lane, mints a model lease, spawns a
 * bridge or a CLI, writes MCP or skill files, delivers a secret or writes a
 * warm marker. The Send does all of that, with fresh authority, as before.
 *
 * The claim is taken before the first sandbox command and released after the
 * last, renewed meanwhile, and a lost renewal stops the preparation. A Send
 * that arrives meanwhile is answered `box_preparing` and waits
 * (`box-preparing-wait.ts`). A preparation stopped by its own deadline or a
 * lost claim may leave a command running in the box, so it leaves the claim
 * to expire instead of releasing it: no Send ever runs beside that command,
 * which E2B ends within `PREPARATION_DEADLINE_MS`, inside the claim's TTL.
 */
import { createHarnessSandboxTemplate } from "@ai-sdk/harness/agent";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { preparePlaygroundTerminalSandbox } from "../computers/control-plane-client.js";
import { logger } from "../logger.js";
import { harnessBootstrapObservation } from "./harness-bake-observer.js";
import {
  releaseHarnessBoxReservation,
  renewHarnessBoxReservation,
  reserveHarnessBox,
  type HarnessBrokerBox,
} from "./harness-model-broker.js";
import { buildBrokerDummyAuth, getHarnessAdapter } from "./registry.js";
import { createHarnessSandboxProvider } from "./sandbox-provider-factory.js";
import { withWarmBridgeBootstrap } from "./warm-bridge-files.js";

const PREPARABLE_HARNESSES = ["claude-code", "codex"] as const;
export type PreparableHarness = (typeof PREPARABLE_HARNESSES)[number];

export function isPreparableHarness(
  harnessId: string | undefined,
): harnessId is PreparableHarness {
  return PREPARABLE_HARNESSES.some((id) => id === harnessId);
}

/** Why the backend booted no box; anything else reads as `skipped`. */
const BACKEND_SKIPS = [
  "disabled",
  "box_exists",
  "materialized_secrets",
  "capacity",
  "member_cap",
  "spend",
  "rate_limited",
] as const;

export type BoxPreparationOutcome =
  | { outcome: "prepared" }
  | {
      outcome: "skipped";
      reason:
        | (typeof BACKEND_SKIPS)[number]
        | "skipped"
        | "not_eligible"
        | "provision_refused"
        | "box_busy";
    }
  | { outcome: "failed" };

/**
 * The whole preparation's bound, and each of its sandbox commands' (E2B ends
 * a command at its timeout). Well past a healthy install, well inside the
 * claim's TTL.
 */
export const PREPARATION_DEADLINE_MS = 3 * 60_000;
/** The turn path's renewal cadence for a claim it holds without a lease. */
const CLAIM_RENEWAL_MS = 60_000;
/** Each renewal or release call's own bound, as the turn path's. */
const CLAIM_CALL_TIMEOUT_MS = 15_000;
/** A dummy proxy for runtimes built only for their recipes; none is started. */
const NO_PROXY_URL = "http://prepare.invalid";

/**
 * The runtimes whose recipes a hosted turn applies, built as the turn builds
 * them, warm and cold, since which one the Send runs is decided at the Send.
 * A recipe reads none of these arguments (`harness-bake.test.ts` holds every
 * hosted recipe to that), so the box ends up as the baked template has it.
 */
export function hostedBootstrapRuntimes(
  harnessId: PreparableHarness,
  modelId: string,
): HarnessAgentAdapter[] {
  const adapter = getHarnessAdapter(harnessId);
  const build = (warmAgent: boolean) =>
    adapter.createHarness({
      modelId,
      warmAgent,
      auth: buildBrokerDummyAuth(harnessId, NO_PROXY_URL),
      mcpJson: { mcpServers: {} },
    });
  const warm = withWarmBridgeBootstrap(build(true));
  return [
    build(false),
    adapter.mcpDelivery === "harness" && adapter.forwardingRuntime
      ? adapter.forwardingRuntime.refresh(warm, {}, "prepare")
      : warm,
  ];
}

export async function prepareConversationBox(args: {
  harnessId: PreparableHarness;
  projectId: string;
  chatSessionId: string;
  /** The environment the Send's box would be booted with, if any. */
  projectEnvironmentId?: string;
  /** The turn's canonical model: the claim is authorized as a lease is. */
  modelId: string;
  /** The member's bearer, for the box itself. */
  bearer: string;
  /** Fresh authority for each claim call, as the turn's own. */
  authorization: () => Promise<string>;
  cleanupAuthorization: () => Promise<string>;
}): Promise<BoxPreparationOutcome> {
  const provisioned = await preparePlaygroundTerminalSandbox({
    bearer: args.bearer,
    projectId: args.projectId,
    chatSessionId: args.chatSessionId,
    ...(args.projectEnvironmentId
      ? { projectEnvironmentId: args.projectEnvironmentId }
      : {}),
    harness: args.harnessId,
    signal: AbortSignal.timeout(PREPARATION_DEADLINE_MS),
  });
  if (!provisioned.ok) return skipped("provision_refused");
  if (provisioned.value.outcome !== "prepared") {
    const reason = provisioned.value.reason;
    return skipped(
      BACKEND_SKIPS.find((known) => known === reason) ?? "skipped",
    );
  }
  const { sandboxId, sandboxRowId } = provisioned.value;
  const box: HarnessBrokerBox = { kind: "sandbox", sandboxRowId };
  const claim = {
    box,
    harnessId: args.harnessId,
    modelId: args.modelId,
    runId: crypto.randomUUID(),
  };
  const claimed = await reserveHarnessBox({
    ...claim,
    purpose: "prepare",
    bearer: await args.authorization(),
  });
  if (!claimed.ok) return skipped("box_busy");

  // Aborted at the deadline or when the claim is lost.
  const stop = new AbortController();
  const { signal } = stop;
  const deadline = setTimeout(
    () => stop.abort(new Error("The preparation ran out of time.")),
    PREPARATION_DEADLINE_MS,
  );
  const renewal = setInterval(() => {
    void args
      .authorization()
      .then((bearer) =>
        renewHarnessBoxReservation({
          ...claim,
          bearer,
          signal: AbortSignal.timeout(CLAIM_CALL_TIMEOUT_MS),
        }),
      )
      .then(
        (renewed) => renewed.ok,
        () => false,
      )
      .then((held) => {
        if (!held && !signal.aborted) {
          logger.warn("[harness-prepare] box claim lost; stopping", {
            harness: args.harnessId,
          });
          stop.abort(new Error("The box claim was lost."));
        }
      });
  }, CLAIM_RENEWAL_MS);
  deadline.unref?.();
  renewal.unref?.();

  // True once every sandbox command this preparation started has ended.
  let settled = false;
  try {
    const provider = createHarnessSandboxProvider({
      sandboxId,
      commandTimeoutMs: PREPARATION_DEADLINE_MS,
    });
    const session = await provider.createSession({ abortSignal: signal });
    for (const runtime of hostedBootstrapRuntimes(
      args.harnessId,
      args.modelId,
    )) {
      const template = await createHarnessSandboxTemplate({
        harnesses: [runtime],
      });
      // Nothing new starts once the deadline passed or the claim was lost.
      signal.throwIfAborted();
      await template?.prepare({
        session: session.restricted(),
        abortSignal: signal,
      });
    }
    settled = true;
    const observed = await harnessBootstrapObservation(provider);
    logger.info("[harness-prepare] box prepared", {
      harness: args.harnessId,
      ...(observed ? { bootstrap: observed.outcome } : {}),
    });
    return { outcome: "prepared" };
  } catch (error) {
    // An abort can leave the interrupted command running; any other failure
    // came back from a call that ended.
    settled = !signal.aborted;
    // Speculative work: the Send prepares the box itself, as it always has.
    // Only the error's class is logged: E2B messages carry ids and output.
    logger.warn("[harness-prepare] box preparation stopped", {
      harness: args.harnessId,
      stoppedBy: signal.aborted ? "deadline_or_lost_claim" : "sandbox",
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { outcome: "failed" };
  } finally {
    clearTimeout(deadline);
    clearInterval(renewal);
    if (settled) {
      await args
        .cleanupAuthorization()
        .then((bearer) =>
          releaseHarnessBoxReservation({
            ...claim,
            bearer,
            signal: AbortSignal.timeout(CLAIM_CALL_TIMEOUT_MS),
          }),
        )
        .then(
          (released) => released.ok,
          () => false,
        )
        .then((released) => {
          // The claim's TTL frees the box if this release is lost.
          if (!released) {
            logger.warn(
              "[harness-prepare] box claim release deferred to expiry",
              {
                harness: args.harnessId,
              },
            );
          }
        });
    }
  }
}

function skipped(
  reason: Extract<BoxPreparationOutcome, { outcome: "skipped" }>["reason"],
): BoxPreparationOutcome {
  return { outcome: "skipped", reason };
}
