/**
 * The saved model selection an assistant turn runs under. The eval, swarm and
 * synthetic paths forward it to the backend on `extraBodyFields` (for
 * `/stream/org`); a harness turn reads the same selection, typed, to run on an
 * organization's own key when it names an org connection on the harness's
 * own vendor. The harness turn keeps only an org selection, so any other
 * source passes through to it inert.
 */
import {
  validateModelSelection,
  type ModelSelection,
} from "@mcpjam/sdk/browser";

/** The forwarded selection, validated, or undefined. Never trusts the shape. */
export function turnModelSelectionOf(
  extraBodyFields: Record<string, unknown> | undefined,
): ModelSelection | undefined {
  const forwarded = extraBodyFields?.modelSelection;
  if (!forwarded || typeof forwarded !== "object") return undefined;
  const validated = validateModelSelection(forwarded);
  return validated.ok ? validated.selection : undefined;
}
