/**
 * The live seams of the reviewer sign-in rehearsal, built from the run's
 * lease alone. This node holds no member's bearer, so every call below is a
 * lease-guarded service route, and the lease is always the one this process
 * created or resumed, never a caller's.
 *
 *   - stages and the outcome: `runs/reviewer-attempt`;
 *   - the credentials: `runs/reviewer-attempt/secrets`, the two secrets the
 *     attempt names and nothing else;
 *   - the desktop: `runs/browser-session` (blank profile), then its `desktop`,
 *     `bind` and `boot`, with browserd started on the box by the per-run path
 *     the eval boxes use, and the browser agent on it. It is NOT recorded:
 *     credentials are typed on it and a recording cannot be paused, so each
 *     stage keeps its own screenshot (`browser-session/screenshot`) instead;
 *   - the one password try: `runs/reviewer-attempt` `passwordSubmission`;
 *   - the connection: `reviewer-connections` create, claim, start, complete
 *     and status, the authorization prepared behind this node's SSRF guard
 *     exactly as for a person's browser.
 *
 * VALIDATE-ON-STAGING, like `browserd/live-session-deps.ts`: only a staging
 * run proves these routes and the hosted browser meet.
 */
import { setTimeout as pause } from "node:timers/promises";
import { MCPJAM_HOSTED_ORIGIN } from "../../config.js";
import { redactForLog } from "../../routes/v1/redact-log-message.js";
import { logger } from "../../utils/logger.js";
import { ensureLiveBrowserSession } from "../browserd/live-session-deps.js";
import { getInternalBackendConfig } from "../internal-backend.js";
import { runConnectionJob } from "../server-connection-worker.js";
import { prepareAuthorization } from "../server-connection-authorize.js";
import {
  parseJsonObject,
  postInternal,
  recordReviewerAttempt,
  ReviewerAttemptRefusedError,
  type ReadinessLease,
} from "./backend-client.js";
import {
  createSignInAgent,
  type SignInAgentDeps,
} from "./reviewer-sign-in-agent.js";
import {
  rehearseReviewerSignIn,
  type ReviewerAttemptView,
  type ReviewerSignInDeps,
  type ReviewerSignInOutcome,
} from "./reviewer-sign-in.js";
import { ReadinessLeaseLostError } from "./runner.js";

const RUNS = "/internal/v1/claude-readiness/runs";
const SESSION = `${RUNS}/browser-session`;
const CONNECTIONS = "/internal/v1/claude-readiness/reviewer-connections";
const CALL_TIMEOUT_MS = 30_000;
/** The desktop route boots the box before it answers. */
const DESKTOP_TIMEOUT_MS = 120_000;
const DESKTOP_RETRIES = 6;
const POLL_MS = 2_000;
/** Discovery runs on the backend's worker before the request can be claimed. */
const CLAIM_WAIT_MS = 45_000;
const CONNECT_WAIT_MS = 60_000;
const SCREENSHOT_UPLOAD_TIMEOUT_MS = 30_000;

const NO_SECRETS =
  "MCPJam could not read the reviewer's saved credentials for this run, so it did not sign in. Start a new attempt after MCPJam updates.";

/** A route's refusal, whichever envelope it answered with. */
export class LeaseRouteRefusal extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LeaseRouteRefusal";
  }
}

/**
 * One lease-guarded POST. The attempt and browser routes answer
 * `{error: code, message}`, the connection routes `{code, error: message}`;
 * a lost lease on either throws `ReadinessLeaseLostError`.
 */
async function leasePost(
  lease: ReadinessLease,
  path: string,
  body: Record<string, unknown> = {},
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const { response, release } = await postInternal(
    path,
    { ...lease, ...body },
    timeoutMs,
  );
  try {
    const answer = parseJsonObject(await response.text()) ?? {};
    if (response.ok && answer.ok !== false) return answer;
    const code = String(
      answer.code ?? answer.error ?? `http_${response.status}`,
    );
    if (code === "lease_lost" || code === "LEASE_MISMATCH") {
      throw new ReadinessLeaseLostError();
    }
    const message =
      typeof answer.message === "string"
        ? answer.message
        : typeof answer.code === "string" && typeof answer.error === "string"
          ? answer.error
          : `MCPJam's backend answered ${response.status}.`;
    throw new LeaseRouteRefusal(code, response.status, message);
  } finally {
    release();
  }
}

/** Ask again while the route says `code`, until `waitMs` has passed. */
async function retrying<T>(
  call: () => Promise<T>,
  options: { code: string; waitMs: number; signal: AbortSignal },
): Promise<T> {
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      const again =
        error instanceof LeaseRouteRefusal && error.code === options.code;
      if (!again || Date.now() > deadline) throw error;
      await pause(POLL_MS, undefined, { signal: options.signal });
    }
  }
}

/** Keep one stage screenshot with this lease's reservation; its id, or nothing. */
async function storeScreenshot(
  lease: ReadinessLease,
  image: { base64: string; mediaType: string },
): Promise<string | undefined> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  const query = new URLSearchParams({ runId: lease.runId, jobId: lease.jobId });
  try {
    const response = await fetch(`${convexUrl}${SESSION}/screenshot?${query}`, {
      method: "POST",
      headers: {
        "content-type": image.mediaType,
        "x-inspector-service-token": serviceToken,
      },
      body: new Uint8Array(Buffer.from(image.base64, "base64")),
      signal: AbortSignal.timeout(SCREENSHOT_UPLOAD_TIMEOUT_MS),
    });
    const answer = parseJsonObject(await response.text());
    return response.ok && typeof answer?.screenshotId === "string"
      ? answer.screenshotId
      : undefined;
  } catch (error) {
    logger.warn("[readiness] a sign-in screenshot was not kept", {
      runId: lease.runId,
      error: redactForLog(error),
    });
    return undefined;
  }
}

/** The one password try, on the attempt, before the value leaves this node. */
function passwordTry(
  lease: ReadinessLease,
  attemptId: string,
): SignInAgentDeps["password"] {
  const write = (commandId: string, outcome: "intent" | "not_typed") =>
    recordReviewerAttempt(lease, attemptId, {
      passwordSubmission: { commandId, outcome },
    });
  return {
    mark: async (commandId) => {
      try {
        await write(commandId, "intent");
        return undefined;
      } catch (error) {
        if (error instanceof ReadinessLeaseLostError) throw error;
        return error instanceof ReviewerAttemptRefusedError &&
          error.code === "password_already_submitted"
          ? `password_already_submitted: ${error.message} Call stop_sign_in with what the page said.`
          : "password_not_recorded: MCPJam could not record the password try, so nothing was typed. Call stop_sign_in.";
      }
    },
    giveBack: async (commandId) => {
      try {
        await write(commandId, "not_typed");
      } catch (error) {
        if (error instanceof ReadinessLeaseLostError) throw error;
        // The try stays spent: the safe side of an unknown answer.
        logger.warn(
          "[readiness] a password try that typed nothing was not given back",
          {
            runId: lease.runId,
            error: redactForLog(error),
          },
        );
      }
    },
  };
}

export function liveReviewerSignInDeps(input: {
  lease: ReadinessLease;
  attemptId: string;
  attempt: ReviewerAttemptView;
}): ReviewerSignInDeps {
  const { lease, attemptId } = input;
  let reservationId: string | undefined;
  let sandboxRowId: string | undefined;
  let requestId = "";

  return {
    record: (write) => recordReviewerAttempt(lease, attemptId, write),
    secrets: async (names) => {
      try {
        const answer = await leasePost(
          lease,
          `${RUNS}/reviewer-attempt/secrets`,
          { attemptId },
        );
        const values = (
          Array.isArray(answer.secrets) ? answer.secrets : []
        ).filter(
          (entry): entry is { name: string; value: string } =>
            typeof entry?.name === "string" &&
            typeof entry?.value === "string" &&
            names.includes(entry.name),
        );
        return names.every((name) =>
          values.some((entry) => entry.name === name),
        )
          ? { values }
          : { unavailable: NO_SECRETS };
      } catch (error) {
        if (error instanceof ReadinessLeaseLostError) throw error;
        // A backend without the route answers its router's 404 with no code.
        const said =
          error instanceof LeaseRouteRefusal && !error.code.startsWith("http_");
        return { unavailable: said ? error.message : NO_SECRETS };
      }
    },
    desktop: {
      reserve: async (signal) => {
        const reserved = await leasePost(lease, SESSION, { profile: "blank" });
        const reservation = reserved.reservation as
          | { id?: unknown }
          | undefined;
        if (typeof reservation?.id !== "string") {
          throw new Error("No browser was reserved for this run.");
        }
        reservationId = reservation.id;
        const box = await retrying(
          () =>
            leasePost(
              lease,
              `${SESSION}/desktop`,
              { reservationId },
              DESKTOP_TIMEOUT_MS,
            ),
          { code: "desktop_starting", waitMs: DESKTOP_RETRIES * 5_000, signal },
        );
        sandboxRowId = String(box.sandboxRowId);
        await leasePost(lease, `${SESSION}/bind`, {
          reservationId,
          sandboxRowId,
        });
        // No member's bearer: without a logical session id the per-run path
        // reads none, and the lease binds and boots the identity instead.
        // Not recorded: credentials are typed on this desktop.
        const sandboxId = String(box.sandboxId);
        const handle = await ensureLiveBrowserSession({
          bearer: "",
          projectId: input.attempt.projectId,
          contextMode: "ephemeral",
          // Only public internet addresses: the submitter's pages steer it.
          networkPolicy: "public",
          target: { kind: "sandbox", sandboxRowId, sandboxId, record: false },
          signal,
        });
        await leasePost(lease, `${SESSION}/boot`, {
          reservationId,
          bootId: handle.bootId,
        });
        const status = await handle.client.status({ signal });
        return {
          agent: createSignInAgent({
            handle,
            features: status.kind === "ok" ? (status.features ?? []) : [],
            lease,
            attemptId,
            projectId: input.attempt.projectId,
            sandbox: { sandboxRowId, sandboxId },
            password: passwordTry(lease, attemptId),
            storeScreenshot: (image) => storeScreenshot(lease, image),
          }),
        };
      },
      release: async () => {
        if (!reservationId) return;
        reservationId = undefined;
        await leasePost(lease, `${SESSION}/close`);
      },
    },
    connect: {
      prepare: async (signal) => {
        const created = await leasePost(lease, CONNECTIONS);
        requestId = String(created.requestId);
        // The preview backend cannot call back into a local Inspector. This run
        // already holds the request id needed to wake the leased worker.
        if (process.env.MCPJAM_LOCAL_DOORBELL_MS && created.status === "discovering") {
          await runConnectionJob(requestId);
        }
        const claim = await retrying(
          () => leasePost(lease, `${CONNECTIONS}/claim`, { requestId }),
          { code: "INVALID_STATE", waitMs: CLAIM_WAIT_MS, signal },
        );
        // The backend validates the callback against its own app origin. Use the
        // value from this leased claim, with the hosted default for older backends.
        const redirectUri = typeof claim.callbackUrl === "string"
          ? claim.callbackUrl
          : new URL("/oauth/callback", MCPJAM_HOSTED_ORIGIN).toString();
        const prepared = await prepareAuthorization({
          serverUrl: String(claim.serverUrl),
          redirectUri,
          requestedName:
            typeof claim.requestedName === "string"
              ? claim.requestedName
              : null,
        });
        // The verifier goes to the backend and nowhere else.
        await leasePost(lease, `${CONNECTIONS}/start`, {
          requestId,
          clientId: prepared.clientId,
          codeVerifier: prepared.codeVerifier,
          redirectUri,
          state: prepared.state,
          ...(prepared.clientSecret
            ? { clientSecret: prepared.clientSecret }
            : {}),
          ...(prepared.issuer ? { issuer: prepared.issuer } : {}),
          ...(prepared.oauthResourceUrl
            ? { oauthResourceUrl: prepared.oauthResourceUrl }
            : {}),
        });
        return {
          authorizationUrl: prepared.authorizationUrl,
          authorizationServerOrigin: new URL(prepared.authorizationUrl).origin,
          callbackUrl: redirectUri,
        };
      },
      complete: async (callback, signal) => {
        try {
          const completed = await leasePost(lease, `${CONNECTIONS}/complete`, {
            requestId,
            ...callback,
          });
          if (process.env.MCPJAM_LOCAL_DOORBELL_MS && completed.status === "validating") {
            await runConnectionJob(requestId);
          }
          const deadline = Date.now() + CONNECT_WAIT_MS;
          for (;;) {
            const status = await leasePost(lease, `${CONNECTIONS}/status`, {
              requestId,
            });
            const account = status.account as { id?: unknown } | undefined;
            if (
              status.stage === "completed" &&
              typeof account?.id === "string"
            ) {
              return { accountId: account.id };
            }
            const error = status.error as { message?: unknown } | undefined;
            const stage = String(status.stage);
            if (["failed", "cancelled", "expired"].includes(stage)) {
              return {
                failed:
                  typeof error?.message === "string"
                    ? error.message
                    : `The connection request ended (${stage}).`,
              };
            }
            if (Date.now() > deadline) {
              return {
                failed: "The connection did not finish within a minute.",
              };
            }
            await pause(POLL_MS, undefined, { signal });
          }
        } catch (error) {
          if (!(error instanceof LeaseRouteRefusal)) throw error;
          return { failed: error.message };
        }
      },
    },
  };
}

/** The rehearsal as a run's worker starts it, on the attempt the run joined. */
export function rehearseReviewerSignInLive(input: {
  lease: ReadinessLease;
  attemptId: string;
  attempt: ReviewerAttemptView;
  signal: AbortSignal;
}): Promise<ReviewerSignInOutcome> {
  return rehearseReviewerSignIn(liveReviewerSignInDeps(input), input.attempt, {
    signal: input.signal,
  });
}
