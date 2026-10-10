import { createHash } from "node:crypto";
import { getInspectorClientRuntimeConfig } from "../env.js";
import {
  CONSERVATIVE_TELEMETRY_POLICY,
  isTelemetryPolicy,
  type TelemetryPolicy,
} from "../../shared/telemetry-privacy.js";

/**
 * The backend's telemetry privacy policy for one capture context, asked as
 * the bearer of the capture request (`telemetryPrivacy:getContext`). Used by
 * the PostHog relay (routes/relay.ts) to decide how to forward each event.
 *
 * Fails closed: no bearer, no Convex URL, an error, a timeout or a malformed
 * answer all resolve to the conservative policy with `resolved: false`. Never
 * throws.
 *
 * An answer is kept for TELEMETRY_POLICY_CACHE_TTL_MS, keyed by a hash of the
 * bearer and the context, so an active tab costs one backend call per
 * context every few seconds rather than one per flush. The TTL is short
 * next to a membership or privacy change, and an honest client tightens
 * sooner anyway: its own label goes restrictive the moment its reactive
 * query does, and the relay takes the stricter of the two. Answers that did
 * not resolve are not kept, so a backend that recovers is asked again.
 */

export const TELEMETRY_POLICY_TIMEOUT_MS = 2_000;
export const TELEMETRY_POLICY_CACHE_TTL_MS = 15_000;
const CACHE_MAX_ENTRIES = 10_000;

export interface TelemetryPolicyContextIds {
  projectIds: string[];
  organizationIds: string[];
}

export interface TelemetryPolicyResolution {
  policy: TelemetryPolicy;
  /** False when the policy is conservative because nothing answered. */
  resolved: boolean;
}

type Query = (
  convexUrl: string,
  token: string,
  context: TelemetryPolicyContextIds,
  signal: AbortSignal,
) => Promise<unknown>;

// Convex's HTTP query API: one fetch, aborted on timeout, no client object.
async function queryConvex(
  convexUrl: string,
  token: string,
  context: TelemetryPolicyContextIds,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(new URL("/api/query", convexUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      path: "telemetryPrivacy:getContext",
      args: context,
      format: "json",
    }),
    signal,
  });
  if (!response.ok) throw new Error(`policy query failed: ${response.status}`);
  const result = (await response.json()) as {
    status?: unknown;
    value?: unknown;
  };
  if (result.status !== "success") throw new Error("policy query failed");
  return result.value;
}

let queryOverride: Query | null = null;
const cache = new Map<
  string,
  { resolution: TelemetryPolicyResolution; expiresAt: number }
>();
const inflight = new Map<string, Promise<TelemetryPolicyResolution>>();

/** Replace the Convex call, and forget every kept answer. Tests only. */
export function setTelemetryPolicyQueryForTests(query: Query | null): void {
  queryOverride = query;
  cache.clear();
  inflight.clear();
}

const UNRESOLVED: TelemetryPolicyResolution = Object.freeze({
  policy: CONSERVATIVE_TELEMETRY_POLICY,
  resolved: false,
});

function cacheKey(token: string, context: TelemetryPolicyContextIds): string {
  const bearer = createHash("sha256").update(token).digest("base64url");
  return `${bearer}\n${JSON.stringify([
    [...context.projectIds].sort(),
    [...context.organizationIds].sort(),
  ])}`;
}

function remember(key: string, resolution: TelemetryPolicyResolution): void {
  if (!resolution.resolved) return;
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, {
    resolution,
    expiresAt: Date.now() + TELEMETRY_POLICY_CACHE_TTL_MS,
  });
}

async function ask(
  query: Query,
  convexUrl: string,
  token: string,
  context: TelemetryPolicyContextIds,
  timeoutMs: number,
): Promise<TelemetryPolicyResolution> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<TelemetryPolicyResolution>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(UNRESOLVED);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      query(convexUrl, token, context, controller.signal).then(
        (value): TelemetryPolicyResolution =>
          isTelemetryPolicy(value)
            ? {
                policy: {
                  recording: value.recording,
                  identity: value.identity,
                },
                resolved: true,
              }
            : UNRESOLVED,
      ),
      timedOut,
    ]);
  } catch {
    return UNRESOLVED;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveTelemetryPolicy(
  token: string | null,
  context: TelemetryPolicyContextIds,
  options: { timeoutMs?: number } = {},
): Promise<TelemetryPolicyResolution> {
  if (!token) return UNRESOLVED;
  const convexUrl = getInspectorClientRuntimeConfig().convexUrl ?? "";
  if (!convexUrl && !queryOverride) return UNRESOLVED;
  const query = queryOverride ?? queryConvex;

  const key = cacheKey(token, context);
  const kept = cache.get(key);
  if (kept) {
    if (kept.expiresAt > Date.now()) return kept.resolution;
    cache.delete(key);
  }
  const pending = inflight.get(key);
  if (pending) return await pending;

  const asked = ask(
    query,
    convexUrl,
    token,
    context,
    options.timeoutMs ?? TELEMETRY_POLICY_TIMEOUT_MS,
  ).then((resolution) => {
    remember(key, resolution);
    return resolution;
  });
  inflight.set(key, asked);
  try {
    return await asked;
  } finally {
    inflight.delete(key);
  }
}
