/**
 * The one rollout decision for the server canvas (`server-canvas`, default
 * off), resolved on the Inspector server for the identity a request's bearer
 * verifies as. Connect capture, probes, OAuth-flow summaries and observation
 * writes all ask this function, so a flag that is off stops every new kind of
 * collection at once.
 *
 * Identity and flag source match `GET /api/web/flags`: the same bearer
 * verification (`verifiedFlagSubject`), the same flag file / DO_NOT_TRACK /
 * PostHog order, and the same `deployment` person property. Hosted, both send
 * `platform: "web"` too. Locally they do not match on `platform`: the flags
 * route takes it from the browser (npm, docker, mac, win, electron), and the
 * connect, refresh, probe and observation requests this gate serves do not
 * carry it, so it is left out here. Rollout conditions for `server-canvas`
 * must therefore not use `platform`; one that does can show the page in the
 * browser while the server collects nothing, or the reverse. Anything that
 * fails to resolve is off.
 */
import { HOSTED_MODE } from "../config.js";
import { serverRolloutAnswer } from "./analytics.js";
import { flagAccountEmail } from "./flag-account.js";
import { verifiedFlagSubject } from "./flag-identity.js";
import { logger } from "./logger.js";

export const SERVER_CANVAS_FLAG = "server-canvas";

/** How long a definite answer, yes or no, stands for one identity. */
export const ROLLOUT_ANSWER_TTL_MS = 60_000;
const keptAnswers = new Map<string, { enabled: boolean; until: number }>();

/** Test seam: forget every kept answer. */
export function resetServerCanvasRolloutForTests(): void {
  keptAnswers.clear();
}

function bearerToken(authorization: string | null | undefined): string {
  return (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
}

/**
 * Whether `server-canvas` is on for the caller behind `authorization` (a
 * bearer token, with or without its `Bearer ` prefix). Never throws.
 *
 * A definite answer, yes or no, is kept for a minute per identity, so with
 * the flag off a connect does not ask Convex and PostHog each time, and a
 * change to the flag reaches every member within the minute. A failed lookup
 * is not kept: the next call asks again, so one failure never holds a member
 * off.
 */
export async function resolveServerCanvasRollout(
  authorization: string | null | undefined,
): Promise<boolean> {
  const token = bearerToken(authorization);
  if (!token) return false;
  try {
    const identity = await verifiedFlagSubject(token);
    if (identity.kind !== "id") return false;
    const kept = keptAnswers.get(identity.distinctId);
    if (kept && kept.until > Date.now()) return kept.enabled;
    const email = identity.member
      ? await flagAccountEmail(token, identity.distinctId)
      : undefined;
    const answer = await serverRolloutAnswer(
      SERVER_CANVAS_FLAG,
      identity.distinctId,
      HOSTED_MODE
        ? { deployment: "hosted", platform: "web" }
        : { deployment: "self_hosted" },
      email,
    );
    const now = Date.now();
    for (const [id, { until }] of keptAnswers) {
      if (until <= now) keptAnswers.delete(id);
    }
    if (answer === undefined) keptAnswers.delete(identity.distinctId);
    else {
      keptAnswers.set(identity.distinctId, {
        enabled: answer,
        until: now + ROLLOUT_ANSWER_TTL_MS,
      });
    }
    return answer === true;
  } catch (error) {
    logger.debug("[server-canvas] rollout check failed; treating it as off", {
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
