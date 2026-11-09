import type { Harness } from "@mcpjam/sdk";
import { HARNESS_DESCRIPTORS } from "@/shared/harness-descriptors";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/**
 * Where a harness that runs on the organization's vendor key (Cursor) may run:
 * the Playground, evals and swarms. Their boxes receive the key, and their
 * turns check it before a box is reserved. User Testing, the v1 APIs and MCP
 * Events runs refuse it, each before anything is reserved.
 */
export type OrgKeyRefusedSurface = "study" | "elsewhere";

export function runsOnOrgVendorKey(harness: Harness): boolean {
  return HARNESS_DESCRIPTORS[harness].modelAccess === "external-account";
}

export function orgKeyHarnessSurfaceRefusal(
  harness: Harness,
  surface: OrgKeyRefusedSurface,
): string {
  return (
    `${HARNESS_DESCRIPTORS[harness].displayName} runs only in the ` +
    "Playground, evals and swarms. " +
    (surface === "study"
      ? "Choose a different client for this study."
      : "Use it there, or choose a different client.")
  );
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
