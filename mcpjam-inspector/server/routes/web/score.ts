import { Hono } from "hono";
import { z } from "zod";
import { getClientIp } from "../../utils/client-ip.js";
import { ErrorCode, WebRouteError, readJsonBody } from "./errors.js";

/**
 * score.mcpjam.com persistence relay.
 *
 * The browser runs the suites (server-side, through `/api/web/conformance/*`)
 * and assembles the report; this pair of routes stores it in Convex and reads
 * it back. The inspector holds the service token, so the backend never has to
 * open a `/public/*` surface and the link token never leaves our own edge.
 *
 * NO BEARER AUTH on either route, and that is the point rather than an
 * oversight (the caniuse mounting precedent): a result link must open for
 * someone with no session at all — a teammate, a maintainer, an incognito
 * window. The token in the URL is the entire credential.
 *
 * Accepted v1 limitation, stated openly: the report is client-assembled, so a
 * determined caller can store a fabricated one. That is tolerable ONLY because
 * a run makes no third-party claim — no badge, no directory, no ranking — so
 * the worst case is somebody lying to themselves via a link only they hold. A
 * badge would require a server-verified re-run.
 */

const score = new Hono();

const BACKEND_CREATE_PATH = "/internal/v1/score/runs";
const BACKEND_GET_PATH = "/internal/v1/score/runs/get";

// A full run takes a while and nobody legitimately stores dozens per minute.
// Matches the caniuse report window rather than inventing a new number.
const SUBMIT_RATE_LIMIT = 10;
const SUBMIT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
/**
 * Bounded like `resultCache` below. Only EXPIRED windows are swept, and the
 * key comes from a client-supplied forwarding header — so a caller rotating
 * `x-forwarded-for` adds one live entry per request and none of them age out
 * for ten minutes. A limiter that can be made to exhaust memory is a liability,
 * not a defense.
 */
const SUBMIT_WINDOW_MAX_ENTRIES = 10_000;
const submitWindows = new Map<string, { count: number; windowStart: number }>();

/** Read misses are cheap individually, so the budget is looser than submits'. */
const READ_MISS_RATE_LIMIT = 60;
const readWindows = new Map<string, { count: number; windowStart: number }>();

function consumeWindow(
  windows: Map<string, { count: number; windowStart: number }>,
  clientKey: string,
  now: number,
  limit: number,
  message: string
) {
  for (const [key, value] of windows) {
    if (now - value.windowStart >= SUBMIT_RATE_LIMIT_WINDOW_MS) {
      windows.delete(key);
    }
  }

  const rateWindow = windows.get(clientKey);
  if (rateWindow) {
    if (rateWindow.count >= limit) {
      throw new WebRouteError(429, ErrorCode.RATE_LIMITED, message);
    }
    rateWindow.count++;
    return;
  }

  if (windows.size >= SUBMIT_WINDOW_MAX_ENTRIES) {
    // Oldest insertion first — Map preserves insertion order.
    const oldest = windows.keys().next();
    if (!oldest.done) windows.delete(oldest.value);
  }
  windows.set(clientKey, { count: 1, windowStart: now });
}

function consumeReadRateLimit(clientKey: string, now: number) {
  consumeWindow(
    readWindows,
    clientKey,
    now,
    READ_MISS_RATE_LIMIT,
    "Too many result lookups. Please try again later."
  );
}

function consumeSubmitRateLimit(clientKey: string, now: number) {
  consumeWindow(
    submitWindows,
    clientKey,
    now,
    SUBMIT_RATE_LIMIT,
    "Too many score submissions. Please try again later."
  );
}

/**
 * Small, short-lived read cache. A shared result link gets opened repeatedly
 * in a burst (a thread, a PR comment), and every hit is otherwise a Convex
 * round trip for a document that can never change — runs are immutable.
 */
const RESULT_CACHE_TTL_MS = 60_000;
const RESULT_CACHE_MAX_ENTRIES = 200;
const resultCache = new Map<string, { at: number; payload: unknown }>();

function readCachedResult(token: string): unknown | null {
  const hit = resultCache.get(token);
  if (!hit) return null;
  if (Date.now() - hit.at > RESULT_CACHE_TTL_MS) {
    resultCache.delete(token);
    return null;
  }
  return hit.payload;
}

function cacheResult(token: string, payload: unknown) {
  if (resultCache.size >= RESULT_CACHE_MAX_ENTRIES) {
    // Oldest insertion first — Map preserves insertion order.
    const oldest = resultCache.keys().next();
    if (!oldest.done) resultCache.delete(oldest.value);
  }
  resultCache.set(token, { at: Date.now(), payload });
}

const summarySchema = z.object({
  score: z.number().nullable(),
  outcome: z.enum(["passed", "failed", "incomplete"]),
  applicable: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  couldNotRun: z.number().int().nonnegative(),
  notApplicable: z.number().int().nonnegative(),
  advisoryCount: z.number().int().nonnegative(),
  protocolVersion: z.string().max(64).optional(),
});

const submitSchema = z.object({
  serverUrl: z.string().trim().min(1).max(2048),
  summary: summarySchema,
  suiteSummaries: z
    .array(
      summarySchema.extend({
        suiteId: z.enum(["protocol", "apps", "tasks", "oauth"]),
      })
    )
    .max(4),
  // The full multi-suite report. Suite CONTENTS are owned by the SDK's
  // conformance result types and stored as an opaque blob — but the outer
  // shape is checked, because the results page indexes into it. A stored
  // `null` would mint a working link to a page that throws on open.
  report: z.record(z.string(), z.unknown()),
});

function backendConfig(): { convexUrl: string; serviceToken: string } {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!convexUrl || !serviceToken) {
    throw new WebRouteError(
      503,
      ErrorCode.INTERNAL_ERROR,
      "Score storage is not configured"
    );
  }
  return { convexUrl: convexUrl.replace(/\/$/, ""), serviceToken };
}

score.post("/runs", async (c) => {
  consumeSubmitRateLimit(getClientIp(c) ?? "unknown", Date.now());

  const parsed = submitSchema.safeParse(await readJsonBody<unknown>(c));
  if (!parsed.success) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      parsed.error.issues[0]?.message ?? "Invalid score run payload"
    );
  }

  const { convexUrl, serviceToken } = backendConfig();

  let response: Response;
  try {
    response = await fetch(`${convexUrl}${BACKEND_CREATE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-inspector-service-token": serviceToken,
      },
      body: JSON.stringify(parsed.data),
    });
  } catch {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      "Failed to store score run"
    );
  }

  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    token?: string;
    error?: string;
  } | null;
  if (!response.ok || body?.ok !== true || !body.token) {
    throw new WebRouteError(
      response.status >= 400 ? response.status : 502,
      ErrorCode.SERVER_UNREACHABLE,
      body?.error ?? "Failed to store score run"
    );
  }

  return c.json({ success: true, token: body.token });
});

score.get("/runs/:token", async (c) => {
  const token = c.req.param("token");
  if (!token) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "Missing token");
  }

  const cached = readCachedResult(token);
  if (cached) {
    return c.json({ success: true, run: cached });
  }

  // Only MISSES are charged. A token is the whole credential, so a guesser
  // gets 404s that never populate the cache — without a budget, every guess is
  // a free Convex round trip and this public route becomes a load amplifier
  // aimed at our own backend. Legitimate readers hit the cache and pay nothing.
  consumeReadRateLimit(getClientIp(c) ?? "unknown", Date.now());

  const { convexUrl, serviceToken } = backendConfig();

  let response: Response;
  try {
    response = await fetch(
      `${convexUrl}${BACKEND_GET_PATH}?token=${encodeURIComponent(token)}`,
      {
        method: "GET",
        headers: { "x-inspector-service-token": serviceToken },
      }
    );
  } catch {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      "Failed to load score run"
    );
  }

  if (response.status === 404) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "That result link is not valid, or the run no longer exists."
    );
  }

  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    run?: unknown;
    error?: string;
  } | null;
  if (!response.ok || body?.ok !== true || !body.run) {
    throw new WebRouteError(
      response.status >= 400 ? response.status : 502,
      ErrorCode.SERVER_UNREACHABLE,
      body?.error ?? "Failed to load score run"
    );
  }

  cacheResult(token, body.run);
  return c.json({ success: true, run: body.run });
});

export default score;
