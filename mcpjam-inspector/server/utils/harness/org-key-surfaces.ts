import type { Harness } from "@mcpjam/sdk";
import { HARNESS_DESCRIPTORS } from "@/shared/harness-descriptors";
import { orgKeySurfaceRefusal } from "@/shared/org-key-surfaces";
import { isWebClientRuntimeId } from "@/shared/web-clients";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/**
 * The server's side of `shared/org-key-surfaces.ts`: the predicate and the
 * study refusal as a chat route's answer. Which surfaces refuse it is declared
 * in the runtime's descriptor (`unavailableOn`).
 */
export function runsOnOrgVendorKey(harness: Harness): boolean {
  return (
    HARNESS_DESCRIPTORS[harness].modelAccess === "external-account" &&
    !isWebClientRuntimeId(harness)
  );
}

/** The study refusal as a chat route's answer. */
export function orgKeyHarnessSurfaceError(harness: Harness): WebRouteError {
  return new WebRouteError(
    422,
    ErrorCode.FEATURE_NOT_SUPPORTED,
    orgKeySurfaceRefusal(HARNESS_DESCRIPTORS[harness].displayName),
    { reason: "HARNESS_UNAVAILABLE", harness, kind: "surface-unsupported" },
  );
}
