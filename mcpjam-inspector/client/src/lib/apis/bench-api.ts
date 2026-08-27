/**
 * Connector Bench client.
 *
 * Two fetch flavours, deliberately:
 *
 *  - The authed calls use `authFetch`, which attaches the hosted bearer for
 *    `/api/web/*` and re-mints it on a 401. A preflight, quote, run or cancel
 *    is spent on behalf of a specific actor and the relay forwards that bearer
 *    to the backend as the second token.
 *  - `fetchBenchResult` uses a plain `fetch`, for the same reason the score
 *    client does: a `/results/<secret>` visitor may have no session, no guest
 *    cookie and no project, and `authFetch` would mint a guest session just to
 *    read a public document. The secret in the URL is the whole credential.
 */

import { authFetch } from "@/lib/session-token";

const BASE = "/api/web/bench";

/** One runnable slice of the bench, as the backend classified this target. */
export interface BenchCategory {
  id: string;
  label: string;
  runnable: boolean;
  /** Why not, when `runnable` is false — safe to show verbatim. */
  reason?: string;
  toolCount?: number;
}

/** A named bundle of categories the score site offers as one choice. */
export interface BenchTrack {
  id: string;
  label: string;
  runnable: boolean;
  categoryIds: string[];
  reason?: string;
}

/** What the caller wants run. IDs come from the preflight response. */
export interface BenchSelection {
  categoryIds?: string[];
  trackIds?: string[];
  actorIds?: string[];
}

export interface BenchPreflight {
  /** Binds a later quote and run to the classification shown here. */
  receiptId: string;
  /** True when the classification was served from cache rather than computed. */
  cached?: boolean;
  categories: BenchCategory[];
  tracks: BenchTrack[];
  /** Per-actor prefill the backend remembers for this caller, if any. */
  preferences?: Record<string, unknown>;
  /** How many tools the relay captured, and whether it had to stop early. */
  toolCount: number;
  toolSnapshotTruncated: boolean;
}

export interface BenchQuote {
  /** Backend-owned line items; rendered, never recomputed here. */
  lineItems?: Array<Record<string, unknown>>;
  totalCredits?: number;
  currency?: string;
  [key: string]: unknown;
}

export type BenchRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface BenchRun {
  runId: string;
  status: BenchRunStatus;
  /** Present once the run has something shareable to point at. */
  resultSecret?: string;
  startedAt?: number;
  finishedAt?: number;
  progress?: Record<string, unknown>;
  error?: string;
}

/** The public artifact behind a result link. Shape is the backend's. */
export interface BenchResult extends Record<string, unknown> {
  runId?: string;
  finishedAt?: number;
}

export class BenchNotEnabledError extends Error {}
export class BenchResultNotFoundError extends Error {}

async function readError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    message?: string;
    error?: string;
  } | null;
  return body?.message ?? body?.error ?? fallback;
}

/**
 * The relay answers a backend that has not enabled benchmark runs with a 503
 * carrying FEATURE_NOT_SUPPORTED. That is a deployment state, not a failure of
 * this request, so it gets its own error type — callers hide the entry point
 * rather than showing a retry.
 */
async function throwFromResponse(
  response: Response,
  fallback: string,
): Promise<never> {
  const body = (await response.json().catch(() => null)) as {
    code?: string;
    message?: string;
    error?: string;
  } | null;
  const message = body?.message ?? body?.error ?? fallback;
  if (response.status === 503 && body?.code === "FEATURE_NOT_SUPPORTED") {
    throw new BenchNotEnabledError(message);
  }
  throw new Error(message);
}

async function benchPost<T>(
  path: string,
  payload: Record<string, unknown>,
  fallback: string,
): Promise<T> {
  const response = await authFetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) await throwFromResponse(response, fallback);
  return (await response.json()) as T;
}

export async function preflightBench(input: {
  projectId: string;
  serverId: string;
}): Promise<BenchPreflight> {
  return benchPost<BenchPreflight>(
    "/preflight",
    input,
    "Could not prepare this benchmark.",
  );
}

export async function quoteBench(input: {
  projectId: string;
  serverId: string;
  selection?: BenchSelection;
}): Promise<BenchQuote> {
  return benchPost<BenchQuote>(
    "/quotes",
    input,
    "Could not price this benchmark.",
  );
}

export async function startBenchRun(input: {
  projectId: string;
  serverId: string;
  receiptId: string;
  selection?: BenchSelection;
  preferences?: Record<string, unknown>;
}): Promise<BenchRun> {
  return benchPost<BenchRun>(
    "/runs",
    input,
    "Could not start this benchmark run.",
  );
}

export async function fetchBenchRun(runId: string): Promise<BenchRun> {
  const response = await authFetch(`${BASE}/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) {
    await throwFromResponse(response, "Could not load this benchmark run.");
  }
  return (await response.json()) as BenchRun;
}

export async function cancelBenchRun(runId: string): Promise<BenchRun> {
  const response = await authFetch(
    `${BASE}/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
  if (!response.ok) {
    await throwFromResponse(response, "Could not cancel this benchmark run.");
  }
  return (await response.json()) as BenchRun;
}

export async function fetchBenchResult(secret: string): Promise<BenchResult> {
  const response = await fetch(`${BASE}/results/${encodeURIComponent(secret)}`);
  if (response.status === 404) {
    throw new BenchResultNotFoundError(
      await readError(
        response,
        "That result link is not valid, or the run no longer exists.",
      ),
    );
  }
  if (!response.ok) {
    await throwFromResponse(response, "Could not load this benchmark result.");
  }
  const body = (await response.json()) as { result?: BenchResult };
  if (!body.result) throw new Error("Could not load this benchmark result.");
  return body.result;
}
