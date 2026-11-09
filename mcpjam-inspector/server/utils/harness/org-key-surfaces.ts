import type { Harness } from "@mcpjam/sdk";
import { HARNESS_DESCRIPTORS } from "@/shared/harness-descriptors";
import {
  orgKeySurfaceRefusal,
  type OrgKeyRefusedSurface,
} from "@/shared/org-key-surfaces";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/**
 * The server's side of `shared/org-key-surfaces.ts`: the predicate, the
 * refusal as a chat route's answer, and the turn sources that never run it.
 */
export type { OrgKeyRefusedSurface };

export function runsOnOrgVendorKey(harness: Harness): boolean {
  return HARNESS_DESCRIPTORS[harness].modelAccess === "external-account";
}

export function orgKeyHarnessSurfaceRefusal(
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

/**
 * The turn sources that never run it, whichever caller reached the turn. The
 * Playground and the v1 chat-session API both send `direct`, so the v1 API is
 * refused where its turn is resolved (`resolveTurnRuntime`), not here.
 */
export function orgKeyRefusedSurfaceFor(
  sourceType: string | undefined,
): OrgKeyRefusedSurface | undefined {
  if (sourceType === "scenario") return "study";
  if (sourceType === "event") return "elsewhere";
  return undefined;
}
