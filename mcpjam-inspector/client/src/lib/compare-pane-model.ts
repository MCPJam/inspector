import type { ModelDefinition } from "@/shared/types";
import { modelRowKey } from "@/components/chat-v2/shared/model-selection";

/**
 * Why a Compare pane must hold back shared Send: the model and connection it
 * shows are not the ones its session would send. Undefined when they agree.
 *
 * The pane shows the row its client resolved to; the session resolves its own
 * row from the same catalog. They differ only when the client's saved model or
 * connection changed under the pane, and sending then would run a model the
 * pane never showed.
 */
export function paneModelDriftReason({
  label,
  shown,
  resolved,
}: {
  label: string;
  shown: ModelDefinition;
  resolved: ModelDefinition;
}): string | undefined {
  if (modelRowKey(shown) === modelRowKey(resolved)) return undefined;
  return `${label}'s model or connection changed. Send again to use the current one.`;
}
