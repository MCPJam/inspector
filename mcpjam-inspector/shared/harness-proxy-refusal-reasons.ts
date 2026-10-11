/**
 * The harness model proxy's refusal vocabulary: every reason the backend's
 * proxy stamps on `x-mcpjam-proxy-refusal`, the status it answers its own
 * refusals with, and whether it invites a retry. How the eval classifier
 * reads each reason is the Inspector's own (`infra-error-classification.ts`).
 *
 * The JSON beside this module is a byte-identical copy of the backend's
 * `convex/harnessModelProxy/refusalReasons.json`, pinned in that repo's
 * `convex/lib/mirrors.json`: change both, or neither.
 */
import { z } from "zod";
import fixture from "./harness-proxy-refusal-reasons.json" with { type: "json" };

export type HarnessProxyRefusalReasonRow = {
  /** The `x-should-retry` the proxy sends with this refusal. */
  retry: boolean;
};

export type HarnessProxyRefusalReason = keyof typeof fixture.reasons;

/**
 * The refusals of a turn on an organization's own key that model resolution
 * also reports: the org policy, the key itself and the transport's caps.
 */
export type HarnessOrgKeyRefusalReason = Extract<
  HarnessProxyRefusalReason,
  "org_keys_required" | `byok_${string}` | `transport_${string}`
>;

/** The status the proxy answers its OWN refusals with: never a provider's. */
export const HARNESS_PROXY_REFUSAL_STATUS: number = fixture.status;

/** Each row checked once, at load. */
const reasonRowSchema = z.object({ retry: z.boolean() });

export const HARNESS_PROXY_REFUSAL_REASONS: Readonly<
  Record<HarnessProxyRefusalReason, HarnessProxyRefusalReasonRow>
> = z.record(z.string(), reasonRowSchema).parse(fixture.reasons) as Record<
  HarnessProxyRefusalReason,
  HarnessProxyRefusalReasonRow
>;

export function isHarnessProxyRefusalReason(
  code: string | undefined,
): code is HarnessProxyRefusalReason {
  return (
    code !== undefined &&
    Object.prototype.hasOwnProperty.call(HARNESS_PROXY_REFUSAL_REASONS, code)
  );
}
