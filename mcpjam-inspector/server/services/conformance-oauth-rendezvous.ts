/**
 * Hosted OAuth conformance across replicas.
 *
 * The suite's run lives on the replica that served `/oauth/start`: the SDK
 * runner keeps the PKCE verifier and the waiting authorization controller in
 * memory and cannot resume anywhere else. Prod runs several replicas and
 * Railway has no sticky sessions, so the browser's later `/oauth/authorize`
 * and `/oauth/complete` land on any of them. Only two things cross over,
 * through a Convex row (backend `conformanceOAuthRendezvous.ts`):
 *
 * - the authorization CODE: whichever replica gets `/oauth/authorize` writes
 *   it with the user's bearer; the running replica polls for it with the
 *   service token, hands it to the run, then acks so Convex scrubs it;
 * - the RESULT: when the run ends, the running replica writes
 *   `toBrowserOAuthResult(...)` (no credentials, headers or bodies); any
 *   replica reads it back for `/oauth/complete`.
 *
 * Same shape as hosted elicitation (`routes/web/hosted-elicitation.ts`): user
 * bearer for what Convex must attribute to the user, service token for the
 * long wait, and poll → deliver → ack in that order so a lost poll response is
 * harmless. Node cannot subscribe to Convex, hence polling.
 */

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { ConformanceResult } from "@mcpjam/sdk";
import {
  CONFORMANCE_OAUTH_COMPLETE_INTERVAL_MS,
  CONFORMANCE_OAUTH_COMPLETE_WAIT_MS,
  CONFORMANCE_OAUTH_CONVEX_TIMEOUT_MS,
  CONFORMANCE_OAUTH_POLL_INTERVAL_MS,
  CONFORMANCE_OAUTH_POLL_JITTER_MS,
  CONFORMANCE_OAUTH_POLL_MAX_FAILURES,
  CONFORMANCE_OAUTH_SHUTDOWN_BUDGET_MS,
} from "./conformance-oauth-rendezvous-config.js";
import { OAUTH_SESSION_EXPIRED_MESSAGE } from "../routes/shared/conformance.js";
import { logger } from "../utils/logger.js";
import { toBrowserOAuthResult } from "../utils/oauth-conformance-browser-result.js";
import {
  AUTHORIZATION_WAIT_MS,
  touchSession,
  type OAuthConformanceSession,
} from "./conformance-oauth-sessions.js";
import {
  hasServiceCredential,
  requireServiceCredential,
} from "./service-credential.js";

/** What the user sees when the replica running their checks shut down. */
export const OAUTH_RUN_STOPPED_MESSAGE =
  "The OAuth checks stopped before they finished. Run the checks again.";

const RESULT_TOO_LARGE_MESSAGE =
  "The OAuth results were too large to send back. Run the checks again.";

/** The backend refuses a larger `resultJson`. */
const MAX_RESULT_BYTES = 512 * 1024;

const FINISH_ATTEMPTS = 3;

type RendezvousStatus =
  | "awaiting_code"
  | "code_submitted"
  | "running"
  | "complete"
  | "failed"
  | "expired";

// Backend `conformanceOAuthRendezvous.ts`, referenced by name (no generated
// `api` object is mirrored into this repo).
const createRef = makeFunctionReference<
  "mutation",
  { sessionId: string; codeWaitMs: number },
  { sessionId: string; expiresAt: number }
>("conformanceOAuthRendezvous:create");
const submitCodeRef = makeFunctionReference<
  "mutation",
  { sessionId: string; code: string; state?: string },
  { ok: boolean; reason?: string }
>("conformanceOAuthRendezvous:submitCode");
const getRef = makeFunctionReference<
  "query",
  { sessionId: string },
  { status: RendezvousStatus; resultJson?: string; error?: string } | null
>("conformanceOAuthRendezvous:get");

// ── Convex plumbing ─────────────────────────────────────────────────────

/**
 * Hosted with Convex and the service credential. Without them (local mode, a
 * dev server with no token) the routes keep the single-process in-memory flow.
 */
export function isConformanceOAuthRendezvousEnabled(): boolean {
  return (
    Boolean(process.env.CONVEX_URL && process.env.CONVEX_HTTP_URL) &&
    hasServiceCredential()
  );
}

function requireEnv(name: "CONVEX_URL" | "CONVEX_HTTP_URL"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function stripBearer(token: string): string {
  return token.replace(/^Bearer\s+/i, "").trim();
}

/**
 * Every Convex call here is bounded: a stalled request would otherwise park the
 * poll loop or hold a route open past the browser's patience. setTimeout
 * rather than `AbortSignal.timeout()` so fake timers control it in tests.
 */
async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error("Convex call deadline exceeded")),
    CONFORMANCE_OAUTH_CONVEX_TIMEOUT_MS,
  );
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(deadline);
  }
}

/** Written with the USER's bearer so Convex derives the owner from `ctx.actor`. */
function userClient(bearer: string, signal: AbortSignal): ConvexHttpClient {
  const client = new ConvexHttpClient(requireEnv("CONVEX_URL"), {
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
      }),
  });
  client.setAuth(stripBearer(bearer));
  return client;
}

/** Service-token routes: the wait spans human time and can outlive the user's token. */
async function serviceRoute<T>(path: string, body: unknown): Promise<T> {
  return await withDeadline(async (signal) => {
    const response = await fetch(
      new URL(path, requireEnv("CONVEX_HTTP_URL")).toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-inspector-service-token":
            requireServiceCredential("OAuth conformance"),
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(`${path} returned ${response.status}`);
    }
    return (await response.json()) as T;
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

// ── Any replica: the browser's calls ────────────────────────────────────

/** Called once the run waits for the user, before the browser gets the URL. */
export async function createRendezvous(
  bearer: string,
  sessionId: string,
): Promise<void> {
  await withDeadline((signal) =>
    userClient(bearer, signal).mutation(createRef, {
      sessionId,
      codeWaitMs: AUTHORIZATION_WAIT_MS,
    }),
  );
}

/**
 * Hand the code to whichever replica runs the session. `gone` covers a missing
 * row, another user's row, an expired window and a finished run — the same
 * cases the in-memory flow answers 404. One retry on a transport error, safe
 * because the first code wins.
 */
export async function submitRendezvousCode(
  bearer: string,
  input: { sessionId: string; code: string; state?: string },
): Promise<"accepted" | "gone"> {
  const submit = () =>
    withDeadline((signal) =>
      userClient(bearer, signal).mutation(submitCodeRef, {
        sessionId: input.sessionId,
        code: input.code,
        ...(input.state !== undefined ? { state: input.state } : {}),
      }),
    );
  let result: { ok: boolean; reason?: string };
  try {
    result = await submit();
  } catch {
    result = await submit();
  }
  return result.ok ? "accepted" : "gone";
}

export type RendezvousOutcome =
  | { phase: "complete"; result: ConformanceResult }
  | { phase: "pending" }
  | { phase: "failed"; error: string }
  | { phase: "gone" };

/**
 * Wait up to `waitMs` for the run's result. A read that fails keeps waiting and
 * at worst ends as `pending`: the browser polls again on `pending` but never
 * retries an error, so a brief Convex hiccup must not end the run for it.
 */
export async function awaitRendezvousResult(
  bearer: string,
  sessionId: string,
  options: { waitMs?: number; intervalMs?: number } = {},
): Promise<RendezvousOutcome> {
  const deadline =
    Date.now() + (options.waitMs ?? CONFORMANCE_OAUTH_COMPLETE_WAIT_MS);
  const intervalMs =
    options.intervalMs ?? CONFORMANCE_OAUTH_COMPLETE_INTERVAL_MS;

  for (;;) {
    let view:
      | { status: RendezvousStatus; resultJson?: string; error?: string }
      | null
      | undefined;
    try {
      view = await withDeadline((signal) =>
        userClient(bearer, signal).query(getRef, { sessionId }),
      );
    } catch (error) {
      logger.warn("[conformance-oauth] result read failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (view === null || view?.status === "expired") return { phase: "gone" };
    if (view?.status === "complete" && view.resultJson !== undefined) {
      return {
        phase: "complete",
        result: JSON.parse(view.resultJson) as ConformanceResult,
      };
    }
    if (view?.status === "failed") {
      return {
        phase: "failed",
        error: view.error ?? OAUTH_RUN_STOPPED_MESSAGE,
      };
    }

    if (Date.now() + intervalMs > deadline) return { phase: "pending" };
    await sleep(intervalMs);
  }
}

// ── The replica running the suite ───────────────────────────────────────

/** Runs on this replica that still wait for a code or a result. */
const liveRuns = new Map<string, AbortController>();

/**
 * This replica's half: wait in Convex for the code, then publish the result.
 * Call once the session is waiting for authorization and its row exists.
 */
export function runRendezvousOnThisReplica(
  session: OAuthConformanceSession,
): void {
  const stopPolling = new AbortController();
  liveRuns.set(session.id, stopPolling);
  void pollForCode(session, stopPolling.signal);

  void session.runnerPromise
    ?.then(
      (result) => publish(session.id, { result }),
      (error) =>
        publish(session.id, {
          error: error instanceof Error ? error.message : String(error),
        }),
    )
    .finally(() => {
      stopPolling.abort();
      liveRuns.delete(session.id);
    });
}

async function pollForCode(
  session: OAuthConformanceSession,
  signal: AbortSignal,
): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    await sleep(
      CONFORMANCE_OAUTH_POLL_INTERVAL_MS +
        Math.random() * CONFORMANCE_OAUTH_POLL_JITTER_MS,
      signal,
    );
    if (signal.aborted) return;

    let row: { status: RendezvousStatus; code?: string; state?: string } | null;
    try {
      const polled = await serviceRoute<{
        ok: boolean;
        rendezvous: typeof row;
      }>("/conformance-oauth/poll", { sessionId: session.id });
      row = polled.rendezvous;
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= CONFORMANCE_OAUTH_POLL_MAX_FAILURES) {
        logger.warn("[conformance-oauth] stopped waiting for the code", {
          error: error instanceof Error ? error.message : String(error),
        });
        session.controller.fail(new Error(OAUTH_RUN_STOPPED_MESSAGE));
        return;
      }
      continue;
    }

    // The browser no longer polls THIS replica, so the poll loop is what keeps
    // the in-memory idle sweep from dropping a run that is still waiting.
    touchSession(session.id);

    if (row?.status === "code_submitted" && row.code) {
      session.controller.deliverCode({
        code: row.code,
        ...(row.state !== undefined ? { state: row.state } : {}),
      });
      // Only after the run has the code: a lost ack just leaves it for the
      // expiry cron to scrub.
      void serviceRoute("/conformance-oauth/ack", {
        sessionId: session.id,
      }).catch((error) =>
        logger.warn("[conformance-oauth] ack failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    if (row?.status !== "awaiting_code") {
      // Gone, expired or already settled: no code is coming for this run.
      session.controller.fail(new Error(OAUTH_SESSION_EXPIRED_MESSAGE));
      return;
    }
  }
}

async function publish(
  sessionId: string,
  outcome: { result: ConformanceResult } | { error: string },
): Promise<void> {
  let body: { resultJson: string } | { error: string };
  if ("result" in outcome) {
    // A result that can't be shaped still has to end the row, or the browser
    // waits out the whole window for nothing.
    let resultJson: string | undefined;
    try {
      resultJson = JSON.stringify(toBrowserOAuthResult(outcome.result));
    } catch (error) {
      logger.warn("[conformance-oauth] result not serializable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    body =
      resultJson === undefined
        ? { error: OAUTH_RUN_STOPPED_MESSAGE }
        : Buffer.byteLength(resultJson) > MAX_RESULT_BYTES
          ? { error: RESULT_TOO_LARGE_MESSAGE }
          : { resultJson };
  } else {
    body = { error: outcome.error };
  }

  for (let attempt = 1; attempt <= FINISH_ATTEMPTS; attempt += 1) {
    try {
      await serviceRoute("/conformance-oauth/finish", { sessionId, ...body });
      return;
    } catch (error) {
      if (attempt === FINISH_ATTEMPTS) {
        logger.warn("[conformance-oauth] could not publish the result", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      await sleep(500 * attempt);
    }
  }
}

/**
 * On shutdown: tell the browser at once that this replica's runs stopped,
 * instead of leaving them to expire. Bounded; the process is exiting anyway.
 */
export async function stopLiveConformanceOAuthRuns(): Promise<void> {
  if (liveRuns.size === 0) return;
  const sessionIds = [...liveRuns.keys()];
  for (const stopPolling of liveRuns.values()) stopPolling.abort();
  liveRuns.clear();

  let budget: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(
      sessionIds.map((sessionId) =>
        serviceRoute("/conformance-oauth/finish", {
          sessionId,
          error: OAUTH_RUN_STOPPED_MESSAGE,
        }),
      ),
    ),
    new Promise<void>((resolve) => {
      budget = setTimeout(resolve, CONFORMANCE_OAUTH_SHUTDOWN_BUDGET_MS);
      budget.unref?.();
    }),
  ]);
  if (budget) clearTimeout(budget);
}

/** For tests. */
export function liveConformanceOAuthRunCount(): number {
  return liveRuns.size;
}
