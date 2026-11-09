import type { Harness } from "@mcpjam/sdk/host-config/internal";
import { HARNESS_DESCRIPTORS } from "./harness-descriptors";

/**
 * Where a harness that runs on the organization's vendor key (Cursor) may run:
 * the Playground, evals and swarms. Their boxes receive the key, and their
 * turns check it before a box is reserved. User Testing, the v1 APIs and MCP
 * Events runs refuse it before anything is reserved, each with this copy.
 */
export type OrgKeyRefusedSurface = "study" | "elsewhere";

/** What a member reads when the org has no usable Cursor key. */
export const ORG_KEY_MISSING_MESSAGE =
  "Ask an org admin to add a Cursor key in Organization → AI providers.";

/** The display name of a harness that runs on the organization's vendor key. */
export function orgKeyHarnessName(
  harnessId: string | null | undefined,
): string | undefined {
  if (!harnessId || !Object.hasOwn(HARNESS_DESCRIPTORS, harnessId)) {
    return undefined;
  }
  const descriptor = HARNESS_DESCRIPTORS[harnessId as Harness];
  return descriptor.modelAccess === "external-account"
    ? descriptor.displayName
    : undefined;
}

export function orgKeySurfaceRefusal(
  displayName: string,
  surface: OrgKeyRefusedSurface,
): string {
  return (
    `${displayName} runs only in the Playground, evals and swarms. ` +
    (surface === "study"
      ? "Choose a different client for this study."
      : "Use it there, or choose a different client.")
  );
}
