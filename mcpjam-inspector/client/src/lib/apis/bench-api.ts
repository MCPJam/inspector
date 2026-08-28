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
/**
 * Mirrors the preflight response's `categories[]` exactly. `id` is the
 * taxonomy category slug.
 */
export interface BenchCategory {
  id: string;
  title: string;
  description: string;
  /** The classifier's ranking, when this category was one of the ranked ones. */
  confidence?: number;
  /**
   * False when no active definition exists for this category — offering it
   * would produce a start request that can only be refused.
   */
  runnable: boolean;
}

/** A named bundle of categories the score site offers as one choice. */
/**
 * Mirrors the preflight response's `tracks[]` exactly. `id` is
 * `${profileId}@${version}` and is for display and selection; the QUOTE is
 * priced from `profileId` (plus `version` as `profileVersion`), so both are
 * carried separately rather than parsed back out of `id`.
 */
export interface BenchTrack {
  id: string;
  definitionId: string;
  profileId: string;
  version: string;
  kind: string;
  /** The taxonomy category this track exams, when it is category-scoped. */
  categoryId?: string;
  definitionHash: string;
  /**
   * True when the exam performs writes against the target, so the quote screen
   * must take explicit consent before starting.
   */
  writesToTarget: boolean;
}

/** What the caller wants run. IDs come from the preflight response. */
export interface BenchSelection {
  categoryIds?: string[];
  trackIds?: string[];
  actorIds?: string[];
}

/** What the caller agreed to before anything is spent against the target. */
export interface BenchConsent {
  authenticatedChecks?: boolean;
  writeCases?: boolean;
}

export interface BenchPreflight {
  /**
   * The stable target the backend resolved or minted for this saved server.
   * Quotes are priced against THIS, not against the server row — carry it
   * into `quoteBench`.
   */
  benchmarkTargetId: string;
  /** Binds a later quote and run to the classification shown here. */
  receiptId: string;
  /** The taxonomy the categories below were drawn from. */
  taxonomyVersion?: string;
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

/**
 * The backend's own union, verbatim — see `BENCHMARK_RUN_STATUSES`. Three of
 * these are terminal verdicts rather than one: a run that reached the end with
 * a full evidence roster is `completed`, one that scored under a publication
 * floor is `provisional`, and one whose evidence never arrived is
 * `insufficient_evidence`. Collapsing them into a single "succeeded" is what a
 * caller must NOT do — the distinction is the whole point of the scorer.
 */
export type BenchRunStatus =
  | "queued"
  | "running"
  | "awaiting_evidence"
  | "assembling"
  | "completed"
  | "provisional"
  | "insufficient_evidence"
  | "failed"
  | "cancelled";

/** The statuses after which polling should stop. */
export const BENCH_TERMINAL_STATUSES: ReadonlySet<BenchRunStatus> = new Set([
  "completed",
  "provisional",
  "insufficient_evidence",
  "failed",
  "cancelled",
]);

export function isBenchRunTerminal(status: BenchRunStatus): boolean {
  return BENCH_TERMINAL_STATUSES.has(status);
}

export interface BenchRun {
  benchmarkRunId: string;
  status: BenchRunStatus;
  profile?: { id: string; version: string; definitionHash: string };
  targetKey?: string;
  verification?: string;
  createdAt?: number;
  startedAt?: number;
  completedAt?: number;
  failureCode?: string;
  failureMessage?: string;
  job?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  /**
   * Returned ONLY by the start call, and only by the invocation that actually
   * stored its hash — the backend keeps a digest, so the plaintext exists
   * exactly once and a poll can never hand it back. Whoever starts a run has
   * to hold on to it; it is not recoverable from `/runs/:runId`.
   */
  resultSecret?: string;
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

/**
 * `benchmarkTargetId` and `profileId` are NOT optional to the backend — it
 * refuses the call without them. Both come out of the preflight response:
 * the target id at its top level, the profile from whichever entry of
 * `tracks` the caller picked. Quoting against the saved server row instead
 * was the original mistake here; a quote is priced against the stable target
 * and one exact exam definition.
 */
export async function quoteBench(input: {
  projectId: string;
  serverId: string;
  benchmarkTargetId: string;
  profileId: string;
  profileVersion?: string;
  consent?: BenchConsent;
  selection?: BenchSelection;
}): Promise<BenchQuote> {
  return benchPost<BenchQuote>(
    "/quotes",
    input,
    "Could not price this benchmark.",
  );
}

/**
 * Starting a run is ACCEPTING a quote, so it carries the `quoteId` the quote
 * call returned. The backend re-checks that quote's definition and consent
 * hashes and refuses with a conflict if the exam moved underneath it — which
 * is why a start cannot be assembled from the target alone.
 */
export async function startBenchRun(input: {
  projectId: string;
  serverId: string;
  quoteId: string;
  receiptId: string;
  consent?: BenchConsent;
  idempotencyKey?: string;
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
