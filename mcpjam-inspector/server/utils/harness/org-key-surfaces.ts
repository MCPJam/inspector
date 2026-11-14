import type { Harness } from "@mcpjam/sdk";
import { HARNESS_DESCRIPTORS } from "@/shared/harness-descriptors";
import {
  orgKeySurfaceRefusal,
  type OrgKeyRefusedSurface,
} from "@/shared/org-key-surfaces";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/**
 * The server's side of `shared/org-key-surfaces.ts`: the predicate and the
 * refusal as a chat route's answer. Which surfaces refuse it is declared in
 * the runtime's descriptor (`unavailableOn`).
 */
export type { OrgKeyRefusedSurface };

export function runsOnOrgVendorKey(harness: Harness): boolean {
  return HARNESS_DESCRIPTORS[harness].modelAccess === "external-account";
}

function orgKeyHarnessSurfaceRefusal(
  harness: Harness,
  surface: OrgKeyRefusedSurface,
): string {
  return orgKeySurfaceRefusal(HARNESS_DESCRIPTORS[harness].displayName, surface);
}

/** The same refusal as a chat route's answer. */
export function orgKeyHarnessSurfaceError(
  harness: Harness,
  surface: OrgKeyRefusedSurface,
): WebRouteError {
  return new WebRouteError(
    422,
    ErrorCode.FEATURE_NOT_SUPPORTED,
    orgKeyHarnessSurfaceRefusal(harness, surface),
    { reason: "HARNESS_UNAVAILABLE", harness, kind: "surface-unsupported" },
  );
}
