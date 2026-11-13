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
 *     the eval boxes use; on release, the recording is read off the box
 *     before `close`, then kept with the reservation;
 *   - the connection: `reviewer-connections` create, claim, start, complete
 *     and status, the authorization prepared behind this node's SSRF guard
 *     exactly as for a person's browser.
 *
 * VALIDATE-ON-STAGING, like `browserd/live-session-deps.ts`: only a staging
 * run proves these routes and the hosted browser meet.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { MCPJAM_HOSTED_ORIGIN } from "../../config.js";
import { redactForLog } from "../../routes/v1/redact-log-message.js";
import { logger } from "../../utils/logger.js";
import type { SandboxHostedBrowserSessionHandle } from "../browserd/browser-session.js";
import {
  collectHostedRecordingThenRelease,
  type HostedRecording,
} from "../browserd/hosted-recording.js";
import { ensureLiveBrowserSession } from "../browserd/live-session-deps.js";
import type {
  BrowserAction,
  BrowserCommandSecret,
} from "../browserd/protocol.js";
import { prepareAuthorization } from "../server-connection-authorize.js";
import {
  parseJsonObject,
  postInternal,
  recordReviewerAttempt,
  type ReadinessLease,
} from "./backend-client.js";
import type { SignInControl } from "./reviewer-sign-in-pages.js";
import {
  rehearseReviewerSignIn,
  type ReviewerAttemptView,
  type ReviewerSignInDeps,
  type ReviewerSignInOutcome,
  type SignInBrowser,
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
const RECORDING_UPLOAD_TIMEOUT_MS = 60_000;

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

function controlsOf(refs: unknown): SignInControl[] {
  type Ref = { role?: unknown; name?: unknown } | null;
  return Object.entries((refs ?? {}) as Record<string, Ref>).flatMap(
    ([ref, entry]) => {
      const name = typeof entry?.name === "string" ? entry.name : "";
      return typeof entry?.role === "string"
        ? [{ ref, role: entry.role, name }]
        : [];
    },
  );
}

/**
 * The page, driven over the daemon's own command route. Every command that can
 * navigate stops at MCPJam's callback (`stopAt`), so its app never loads; the
 * URL the redirect carried is then read back as the page, and only the
 * driver's `complete` call takes its `code` and `state` from there.
 */
function browserOn(
  handle: SandboxHostedBrowserSessionHandle,
  features: readonly string[],
  frame: (atMs: number) => string,
  options: { callbackUrl: string; signal: AbortSignal },
): SignInBrowser {
  let stoppedAt: string | undefined;
  const send = async (
    action: BrowserAction,
    secrets: BrowserCommandSecret[] = [],
  ) => {
    const navigates = action.kind === "navigate" || action.kind === "act";
    const answer = await handle.client.sendCommand(
      {
        commandId: randomUUID(),
        source: "inspector",
        action,
        ...(navigates ? { stopAt: options.callbackUrl } : {}),
      },
      handle.bootId,
      { signal: options.signal, secrets },
    );
    if (answer.status !== "ok") {
      throw new Error(
        `The hosted browser did not run the command (${answer.status}).`,
      );
    }
    // Checked before `ok`: a stopped navigation can end the command unloaded.
    if (answer.result.stoppedAt) {
      stoppedAt = answer.result.stoppedAt;
      return {};
    }
    if (!answer.result.ok) {
      throw new Error(
        `The hosted browser refused the command: ${answer.result.error ?? "no reason given"}`,
      );
    }
    const output = answer.result.output;
    return (
      typeof output === "object" && output !== null ? output : {}
    ) as Record<string, unknown>;
  };
  return {
    features,
    open: async (url) => {
      await send({ kind: "navigate", url });
    },
    read: async () => {
      if (stoppedAt) return { url: stoppedAt, text: "", controls: [] };
      // The tree first: its refs stay valid through the text read after it.
      const tree = await send({
        kind: "observe",
        mode: "a11y",
        filter: "interactive",
      });
      const page = await send({ kind: "observe", mode: "text" });
      return {
        url: String(page.url ?? tree.url ?? ""),
        text: String(page.text ?? ""),
        controls: controlsOf(tree.refs),
      };
    },
    type: async (ref, text, { secrets, submit }) => {
      await send(
        {
          kind: "act",
          verb: "type",
          target: { a11yRef: ref },
          value: text,
          submit,
          observe: "none",
        },
        secrets,
      );
    },
    click: async (ref) => {
      await send({
        kind: "act",
        verb: "click",
        target: { a11yRef: ref },
        observe: "none",
      });
    },
    screenshot: async () => frame(Date.now()),
  };
}

/** Keep the recording with its reservation. A run without it keeps its stages. */
async function keepRecording(
  lease: ReadinessLease,
  recording: HostedRecording,
) {
  try {
    const grant = await leasePost(lease, `${SESSION}/recording/upload-url`);
    const uploaded = await fetch(String(grant.uploadUrl), {
      method: "POST",
      headers: { "content-type": recording.mime },
      body: new Uint8Array(recording.bytes),
      signal: AbortSignal.timeout(RECORDING_UPLOAD_TIMEOUT_MS),
    });
    const stored = parseJsonObject(await uploaded.text());
    if (!uploaded.ok || typeof stored?.storageId !== "string") {
      throw new Error(`the recording upload answered ${uploaded.status}`);
    }
    const { fps, durationMs, distinctFrames, truncated } = recording;
    await leasePost(lease, `${SESSION}/recording`, {
      uploadGrantId: grant.uploadGrantId,
      storageId: stored.storageId,
      meta: { source: "hosted", fps, durationMs, distinctFrames, truncated },
    });
  } catch (error) {
    logger.warn("[readiness] the sign-in recording was not kept", {
      runId: lease.runId,
      error: redactForLog(error),
    });
  }
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
  const redirectUri = new URL(
    "/oauth/callback",
    MCPJAM_HOSTED_ORIGIN,
  ).toString();

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
          { id?: unknown } | undefined;
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
        const handle = await ensureLiveBrowserSession({
          bearer: "",
          projectId: input.attempt.projectId,
          contextMode: "ephemeral",
          target: {
            kind: "sandbox",
            sandboxRowId,
            sandboxId: String(box.sandboxId),
            record: true,
          },
          signal,
        });
        const recordingFrom = Date.now();
        await leasePost(lease, `${SESSION}/boot`, {
          reservationId,
          bootId: handle.bootId,
        });
        const status = await handle.client.status({ signal });
        const id = reservationId;
        return {
          browser: browserOn(
            handle,
            status.kind === "ok" ? (status.features ?? []) : [],
            // A frame of the run's recording: no lease route keeps a screenshot.
            (atMs) =>
              `${id}#t=${Math.max(0, (atMs - recordingFrom) / 1000).toFixed(1)}`,
            { callbackUrl: redirectUri, signal },
          ),
          recordingArtifactId: id,
        };
      },
      release: async () => {
        if (!reservationId) return;
        reservationId = undefined;
        const close = () => leasePost(lease, `${SESSION}/close`);
        if (!sandboxRowId) {
          await close();
          return;
        }
        // The file is on the box, so it is read before `close` retires it.
        const recording = await collectHostedRecordingThenRelease({
          sandboxRowId,
          release: close,
        });
        if (recording) await keepRecording(lease, recording);
      },
    },
    connect: {
      prepare: async (signal) => {
        const created = await leasePost(lease, CONNECTIONS);
        requestId = String(created.requestId);
        const claim = await retrying(
          () => leasePost(lease, `${CONNECTIONS}/claim`, { requestId }),
          { code: "INVALID_STATE", waitMs: CLAIM_WAIT_MS, signal },
        );
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
          authorizationServerOrigin: new URL(
            String(claim.authorizationServerUrl),
          ).origin,
          callbackUrl: redirectUri,
        };
      },
      complete: async (callback, signal) => {
        try {
          await leasePost(lease, `${CONNECTIONS}/complete`, {
            requestId,
            ...callback,
          });
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
