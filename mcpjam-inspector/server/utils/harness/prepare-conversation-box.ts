/**
 * Prepare a new hosted chat's computer while its first message is typed.
 *
 * The first Send of a hosted Claude Code or Codex chat creates the
 * conversation's box and installs the agent before the model sees a byte.
 * This does those two things earlier, and nothing else: it boots the box on
 * the preparation's own route, claims it under the per-box reservation that
 * fences every turn's preparation, attaches, and runs the pnpm guard and the
 * framework's bootstrap (a marker check, or the install) for the agent's
 * recipes.
 *
 * It never claims the conversation's lane, mints a model lease, spawns a
 * bridge or a CLI, writes MCP or skill files, delivers a secret or writes a
 * warm marker. The Send does all of that, with fresh authority, as before.
 *
 * The claim is taken before anything starts in the box and renewed meanwhile;
 * a renewal it cannot confirm stops the preparation. Each write and command
 * starts only if it will end before the claim can lapse, every command under
 * coreutils `timeout -s KILL` in the box (`preparation-fence.ts`); a box
 * without that `timeout` is skipped. A Send that arrives meanwhile is answered
 * `box_preparing` and waits (`box-preparing-wait.ts`). The claim is always
 * released, with how the preparation ended: `clean` once every call in the
 * box returned, or none started, leaving the box for the Send; `uncertain`
 * after one that threw or never returned, since it may still reach the box.
 * The backend retires an uncertain box, as it does one whose claim lapsed, so
 * no Send ever runs on it (`box_retired`).
 */
import { createHarnessSandboxTemplate } from "@ai-sdk/harness/agent";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { preparePlaygroundTerminalSandbox } from "../computers/control-plane-client.js";
import { logger } from "../logger.js";
import {
  harnessBootstrapObservation,
  watchNewBoxForStaleBake,
} from "./harness-bake-observer.js";
import { harnessPnpmGuardCommand } from "./harness-bake.js";
import {
  releaseHarnessBoxReservation,
  renewHarnessBoxReservation,
  reserveHarnessBox,
  type BoxReleaseOutcome,
} from "./harness-box-reservation.js";
import type { HarnessBrokerBox } from "./harness-model-broker.js";
import { PreparationFence, StaleClaimError } from "./preparation-fence.js";
import {
  CLAIM_CALL_TIMEOUT_MS,
  CLAIM_RENEWAL_MS,
  PREPARATION_DEADLINE_MS,
} from "./preparation-timing.js";
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
        | "box_busy"
        | "no_timeout";
    }
  | { outcome: "failed" };

/** Each command's bound inside the box, well past a healthy install. */
export const COMMAND_BOUND_MS = 150_000;
/** The request's way to the box, on top of a command's bound. */
const FENCE_MARGIN_MS = 30_000;
/** Only coreutils `timeout` kills a command's whole process group. */
const TIMEOUT_PROBE = "timeout --version";
const GNU_TIMEOUT = /^timeout \(GNU coreutils\)/m;
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
  // A backend without the preparation's route answers 404: switched off.
  if (!provisioned.ok) {
    return skipped(
      provisioned.status === 404 ? "disabled" : "provision_refused",
    );
  }
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
  const release = async (outcome: BoxReleaseOutcome) => {
    const released = await args.cleanupAuthorization().then(
      (bearer) =>
        releaseHarnessBoxReservation({
          ...claim,
          outcome,
          bearer,
          signal: AbortSignal.timeout(CLAIM_CALL_TIMEOUT_MS),
        }),
      () => ({ ok: false }),
    );
    // If this release is lost, the claim lapses, and a lapsed preparation
    // claim retires the box: the backend marked it when the claim was made.
    // So a box this cannot hand back is never reused.
    if (!released.ok) {
      logger.warn(
        "[harness-prepare] box claim release failed; a lapsed claim retires it",
        { harness: args.harnessId, outcome },
      );
    }
  };

  // Aborted at the deadline or when the claim is lost.
  const stop = new AbortController();
  const { signal } = stop;
  const fence = new PreparationFence({
    commandBoundMs: COMMAND_BOUND_MS,
    marginMs: FENCE_MARGIN_MS,
    signal,
  });
  const claimBearer = await args.authorization();
  const claimSentAt = performance.now();
  const claimed = await reserveHarnessBox({
    ...claim,
    purpose: "prepare",
    bearer: claimBearer,
    signal: AbortSignal.timeout(CLAIM_CALL_TIMEOUT_MS),
  });
  if (!claimed.ok) {
    // A call the backend did not answer, or whose answer could not be read
    // (502), may still have made the claim. Nothing ran in the box: `clean`.
    // A release that arrives first is recorded, and the late claim refused.
    if (claimed.status >= 500) await release("clean");
    return skipped("box_busy");
  }
  fence.confirm(claimSentAt, claimed.ttlMs);
  const deadline = setTimeout(
    () => stop.abort(new Error("The preparation ran out of time.")),
    PREPARATION_DEADLINE_MS,
  );
  const renewal = setInterval(() => {
    void args
      .authorization()
      .then(async (bearer) => {
        const sentAt = performance.now();
        const renewed = await renewHarnessBoxReservation({
          ...claim,
          bearer,
          signal: AbortSignal.timeout(CLAIM_CALL_TIMEOUT_MS),
        });
        if (renewed.ok) fence.confirm(sentAt, renewed.ttlMs);
        return renewed.ok;
      })
      .then(
        (held) => held,
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

  try {
    const provider = createHarnessSandboxProvider({
      sandboxId,
      commandTimeoutMs: COMMAND_BOUND_MS + FENCE_MARGIN_MS,
      skipPnpmGuard: true,
    });
    // The box was just booted for this chat, as a first Send's would be, and
    // its Send will find this install: a bake miss here is the stale-template
    // alert the Send would have raised.
    watchNewBoxForStaleBake(provider, args.harnessId);
    // Attaching starts nothing in the box; the guard runs below, fenced.
    const session = (
      await provider.createSession({ abortSignal: signal })
    ).restricted();
    const probe = await fence.probe(session, TIMEOUT_PROBE);
    if (!GNU_TIMEOUT.test(probe.stdout)) return skipped("no_timeout");
    const fenced = fence.session(session);
    const guard = await fenced.run({ command: harnessPnpmGuardCommand() });
    if (guard.exitCode !== 0) {
      throw new Error(`The pnpm guard failed (exit ${guard.exitCode}).`);
    }
    for (const runtime of hostedBootstrapRuntimes(
      args.harnessId,
      args.modelId,
    )) {
      const template = await createHarnessSandboxTemplate({
        harnesses: [runtime],
      });
      await template?.prepare({ session: fenced, abortSignal: signal });
    }
    const observed = await harnessBootstrapObservation(provider);
    logger.info("[harness-prepare] box prepared", {
      harness: args.harnessId,
      ...(observed ? { bootstrap: observed.outcome } : {}),
    });
    return { outcome: "prepared" };
  } catch (error) {
    // Speculative work: the Send prepares the box itself, as it always has.
    // Only the error's class is logged: E2B messages carry ids and output.
    logger.warn("[harness-prepare] box preparation stopped", {
      harness: args.harnessId,
      stoppedBy: signal.aborted
        ? "deadline_or_lost_claim"
        : error instanceof StaleClaimError
          ? "stale_claim"
          : "sandbox",
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { outcome: "failed" };
  } finally {
    clearTimeout(deadline);
    clearInterval(renewal);
    // `clean` only when the fence proves every call in the box returned, or
    // none started. A call that threw or never returned may still reach the
    // box after a Send takes it, so the box is released `uncertain` instead,
    // and the backend retires it rather than hand it to the Send.
    const { outcome } = fence;
    if (outcome === "uncertain") {
      logger.info("[harness-prepare] box released uncertain; it is retired", {
        harness: args.harnessId,
      });
    }
    await release(outcome);
  }
}

function skipped(
  reason: Extract<BoxPreparationOutcome, { outcome: "skipped" }>["reason"],
): BoxPreparationOutcome {
  return { outcome: "skipped", reason };
}
