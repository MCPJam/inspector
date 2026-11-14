/**
 * The organization AI key policy ("Use your keys for all AI features"), read
 * the same way by the Inspector server and the browser.
 *
 * Only the backend decides whether an organization connection may serve AI
 * requests while the policy is on. It puts its verdict on every connection it
 * hands the Inspector (`policyEligibility`), and computes it with the same
 * function its own admission runs on every attempt, so the two can't drift.
 * This module only reads that verdict. It never works one out from a provider
 * key, a runtime location or a base URL.
 *
 * An older backend sends no verdict. While the policy is on, a connection
 * without one is treated as not eligible (`org_keys_required`): the Inspector
 * would rather refuse a request than run it on a connection nobody vouched
 * for. With the policy off, a missing verdict changes nothing.
 *
 * Everything here reads untrusted JSON and never throws.
 */
import {
  recognizedAiRefusalCode,
  type AiRefusalCode,
} from "./ai-execution-refusal.js";

/** The organization's AI key policy. */
export type OrgAiKeyPolicy = {
  /** Every AI request must run on an eligible organization connection. */
  requireOrgKeys: boolean;
  /** The policy's revision, when the backend reports one. */
  revision?: number;
};

/** The backend's verdict on one organization connection. */
export type PolicyEligibility = {
  /** Whether AI requests may run on this connection while the policy is on. */
  eligible: boolean;
  /** Why not, from the shared refusal list. Always set when not eligible. */
  code?: AiRefusalCode;
  /** Short plain text the backend wrote for display. */
  message?: string;
};

/** Longest backend message kept, so a bad answer can't flood the UI. */
const MAX_MESSAGE_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The policy from untrusted JSON, or `undefined` when there is none. Anything
 * but `requireOrgKeys: true` reads as off.
 */
export function normalizeOrgAiKeyPolicy(
  raw: unknown,
): OrgAiKeyPolicy | undefined {
  if (!isRecord(raw)) return undefined;
  const policy: OrgAiKeyPolicy = {
    requireOrgKeys: raw.requireOrgKeys === true,
  };
  if (typeof raw.revision === "number" && Number.isFinite(raw.revision)) {
    policy.revision = raw.revision;
  }
  return policy;
}

/**
 * Whether this config says the organization requires its own provider keys.
 * Reads `aiKeyPolicy.requireOrgKeys`, which the backend sends next to the
 * connections. A config without a policy (an older backend) reads as off.
 */
export function orgRequiresOwnKeys(
  config: { readonly aiKeyPolicy?: unknown } | null | undefined,
): boolean {
  return normalizeOrgAiKeyPolicy(config?.aiKeyPolicy)?.requireOrgKeys === true;
}

/**
 * A connection's verdict from untrusted JSON, or `undefined` when it is
 * missing or malformed. A verdict of "not eligible" always carries a code: an
 * unknown or missing one reads as `org_keys_required`.
 */
export function normalizePolicyEligibility(
  raw: unknown,
): PolicyEligibility | undefined {
  if (!isRecord(raw) || typeof raw.eligible !== "boolean") return undefined;
  if (raw.eligible) return { eligible: true };
  const message =
    typeof raw.message === "string"
      ? raw.message.trim().slice(0, MAX_MESSAGE_LENGTH)
      : "";
  return {
    eligible: false,
    code:
      (typeof raw.code === "string"
        ? recognizedAiRefusalCode(raw.code)
        : undefined) ?? "org_keys_required",
    ...(message ? { message } : {}),
  };
}

/**
 * The backend's verdict on an organization connection.
 *
 * With the verdict present, it is returned as the backend sent it, whether or
 * not the policy is on: it describes the connection, not the organization's
 * setting. Callers enforce it only while the policy is on.
 *
 * With the verdict missing (an older backend), the answer depends on the
 * policy: while it is on, the connection is not eligible
 * (`org_keys_required`); while it is off, nothing is refused.
 */
export function connectionPolicyEligibility(
  row: { readonly policyEligibility?: unknown } | null | undefined,
  requireOrgKeys: boolean,
): PolicyEligibility {
  const verdict = normalizePolicyEligibility(row?.policyEligibility);
  if (verdict) return verdict;
  return requireOrgKeys
    ? { eligible: false, code: "org_keys_required" }
    : { eligible: true };
}
