/**
 * A Send that meets a box a preparation is still setting up.
 *
 * While `prepare-conversation-box.ts` holds a box's claim, the backend answers
 * any other run's claim or lease start `box_preparing`. A healthy preparation
 * releases its claim within seconds, so the Send retries with backoff for at
 * most `BOX_PREPARING_WAIT_MS`, longer than an agent install on a box without
 * the baked runtime takes. Past that the preparer may have died, and its claim
 * holds until its TTL (the backend's `HARNESS_BOX_PREPARATION_TTL_MS`, five
 * minutes): the Send never runs beside it. It stops before any sandbox
 * command, with an error the person can retry; a retry once the claim has
 * lapsed proceeds.
 */
import { setTimeout as delay } from "node:timers/promises";
import { HarnessInfraSetupError } from "./harness-provider-error.js";

export const BOX_PREPARING_CODE = "box_preparing";
export const BOX_PREPARING_WAIT_MS = 30_000;

/**
 * Run `attempt` (a claim or a lease start) until it answers anything but
 * `box_preparing`, waiting between tries, and give up with a typed, retryable
 * error once the next try would land past the bound.
 */
export async function waitOutBoxPreparation<
  T extends { ok: boolean; code?: string },
>(attempt: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const giveUpAt = Date.now() + BOX_PREPARING_WAIT_MS;
  for (let tries = 0; ; tries++) {
    const result = await attempt();
    if (result.ok || result.code !== BOX_PREPARING_CODE) return result;
    const pause = Math.min(500 * 2 ** tries, 4_000);
    if (Date.now() + pause > giveUpAt) {
      throw new HarnessInfraSetupError(
        "This conversation's computer is still being set up. Send your message again in a moment.",
        { source: "sandbox_setup", code: BOX_PREPARING_CODE, httpStatus: 409 },
      );
    }
    await delay(pause, undefined, signal ? { signal } : undefined);
  }
}
