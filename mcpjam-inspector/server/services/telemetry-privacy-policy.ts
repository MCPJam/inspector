import { ConvexHttpClient } from "convex/browser";
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
 * cached — a permissive answer is only ever the backend's answer for this
 * request — and never throws.
 */

export const TELEMETRY_POLICY_TIMEOUT_MS = 2_000;

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
) => Promise<unknown>;

async function queryConvex(
  convexUrl: string,
  token: string,
  context: TelemetryPolicyContextIds,
): Promise<unknown> {
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token);
  return await client.query("telemetryPrivacy:getContext" as any, context);
}

let queryOverride: Query | null = null;

/** Replace the Convex call. Tests only; pass `null` to restore. */
export function setTelemetryPolicyQueryForTests(query: Query | null): void {
  queryOverride = query;
}

const UNRESOLVED: TelemetryPolicyResolution = Object.freeze({
  policy: CONSERVATIVE_TELEMETRY_POLICY,
  resolved: false,
});

export async function resolveTelemetryPolicy(
  token: string | null,
  context: TelemetryPolicyContextIds,
  options: { timeoutMs?: number } = {},
): Promise<TelemetryPolicyResolution> {
  if (!token) return UNRESOLVED;
  const convexUrl = getInspectorClientRuntimeConfig().convexUrl ?? "";
  if (!convexUrl && !queryOverride) return UNRESOLVED;
  const query = queryOverride ?? queryConvex;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof UNRESOLVED>((resolve) => {
    timer = setTimeout(
      () => resolve(UNRESOLVED),
      options.timeoutMs ?? TELEMETRY_POLICY_TIMEOUT_MS,
    );
  });
  try {
    const answer = await Promise.race([
      query(convexUrl, token, context).then(
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
    return answer;
  } catch {
    return UNRESOLVED;
  } finally {
    clearTimeout(timer);
  }
}
