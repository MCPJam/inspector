import { buildAppPermalink } from "@mcpjam/sdk/platform";
import { MCPJAM_HOSTED_ORIGIN } from "../../config.js";
import { NATIVE_HARNESS_TRIAL_EXHAUSTED_CODE } from "@/shared/native-harness-trial";

/** The organization's billing page: its settings permalink, then Billing. */
function organizationBillingUrl(organizationId: string): string {
  const url = new URL(
    buildAppPermalink(
      { type: "organization", id: organizationId },
      { appOrigin: MCPJAM_HOSTED_ORIGIN },
    ).url,
  );
  url.pathname = `${url.pathname}/billing`;
  return url.toString();
}

/**
 * A native turn refused because the Free organization has used its native
 * harness trial, as a v1 error's `details`, or `undefined` for any other code.
 *
 * The public code stays the existing `FORBIDDEN`: the v1 code list is a
 * mirrored fixture. `reason` is what a program branches on, and `upgradeUrl`
 * the organization's billing page, the same page the backend's refusal names.
 * The harness layers between the backend and this route keep only the code, so
 * the page is rebuilt here from the caller's organization.
 */
export function nativeHarnessRefusalDetails(
  code: string | undefined,
  organizationId: string | undefined,
): { reason: string; upgradeUrl?: string } | undefined {
  if (code !== NATIVE_HARNESS_TRIAL_EXHAUSTED_CODE) return undefined;
  return {
    reason: NATIVE_HARNESS_TRIAL_EXHAUSTED_CODE,
    ...(organizationId
      ? { upgradeUrl: organizationBillingUrl(organizationId) }
      : {}),
  };
}
