/**
 * The harness model proxy's refusal vocabulary: every reason the backend's
 * proxy stamps on `x-mcpjam-proxy-refusal`, the status it answers its own
 * refusals with, and how the eval infra classifier reads each one.
 *
 * The JSON beside this module is a byte-identical copy of the backend's
 * `convex/harnessModelProxy/refusalReasons.json`, pinned in that repo's
 * `convex/lib/mirrors.json`: change both, or neither.
 */
import fixture from "./harness-proxy-refusal-reasons.json" with { type: "json" };
import type { EvalInfraErrorClass } from "./eval-infra-error";

export type HarnessProxyRefusalReasonRow = {
  /** The `x-should-retry` the proxy sends with this refusal. */
  retry: boolean;
  /** The infra class, or `null`: not an infrastructure failure. */
  class: EvalInfraErrorClass | null;
};

export type HarnessProxyRefusalReason = keyof typeof fixture.reasons;

/** The status the proxy answers its OWN refusals with: never a provider's. */
export const HARNESS_PROXY_REFUSAL_STATUS: number = fixture.status;

export const HARNESS_PROXY_REFUSAL_REASONS: Readonly<
  Record<HarnessProxyRefusalReason, HarnessProxyRefusalReasonRow>
> = fixture.reasons as Record<
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
