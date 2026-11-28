import type { Harness } from "@mcpjam/sdk/host-config/internal";
import { HARNESS_DESCRIPTORS } from "./harness-descriptors";
import { isWebClientRuntimeId } from "./web-clients";

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
  // A web account is the project's, not an organization key.
  return descriptor.modelAccess === "external-account" &&
    !isWebClientRuntimeId(harnessId)
    ? descriptor.displayName
    : undefined;
}

/**
 * Why a harness that runs on the organization's vendor key (Cursor) is refused
 * in User Testing, whose participants control the box. The Playground, evals,
 * swarms and the API give their boxes the key and check it before a box is
 * reserved; a study refuses it before anything is reserved, with this copy.
 */
export function orgKeySurfaceRefusal(displayName: string): string {
  return (
    `${displayName} runs only in the Playground, evals, swarms and the API. ` +
    "Choose a different client for this study."
  );
}
