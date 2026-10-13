/**
 * Which reasoning efforts a control may offer for a picker row.
 *
 * A thin adapter over the SDK's one capability table
 * (`supportedReasoningEfforts`): hosted rows read the catalog's list off the
 * row, BYOK / local rows read the per-model provider table, and a harness
 * turn reads the adapter's verified table (empty until verified). Empty means
 * "hide the control" — an unknown capability is never guessed.
 *
 * Pass the CONCRETE route: `org` (runtime not yet known) answers "none"; `orgCloud`
 * reads the provider tables like `direct`.
 */
import {
  defaultReasoningEffort,
  selectionKey,
  supportedReasoningEfforts,
  type ModelReasoningEffort,
  type ReasoningEffortRoute,
} from "@mcpjam/sdk/browser";
import type { Harness } from "@mcpjam/sdk/host-config/internal";
import type { ModelDefinition } from "@/shared/types";
import { isMCPJamProvidedModelMenuItem } from "@/components/chat-v2/shared/model-helpers";
import {
  modelRowKey,
  modelSelectionFromDefinition,
} from "@/components/chat-v2/shared/model-selection";

export type EffortRow = Pick<ModelDefinition, "id" | "provider"> &
  Partial<Pick<ModelDefinition, "supportedReasoningEfforts">>;

export function reasoningEffortOptions(
  row: EffortRow,
  route: ReasoningEffortRoute,
  harness?: Harness,
): ModelReasoningEffort[] {
  return supportedReasoningEfforts({
    route,
    providerKey: String(row.provider),
    modelId: String(row.id),
    catalogEfforts: row.supportedReasoningEfforts,
    harness,
  });
}

/**
 * The concrete route a picker row runs on, for the capability table: hosted
 * catalog rows read the catalog's list, an org-provided row's runtime is not
 * known from the row alone (`org` ⇒ no efforts offered), and every other row
 * is the user's own key on this machine (`direct`).
 */
export function reasoningEffortRouteForRow(
  row: Pick<ModelDefinition, "id" | "provider"> &
    Partial<Pick<ModelDefinition, "hosted" | "orgProvider">>,
): ReasoningEffortRoute {
  if (isMCPJamProvidedModelMenuItem(row as ModelDefinition)) return "hosted";
  if (row.orgProvider) return "org";
  return "direct";
}

/**
 * The level the provider applies to this row when no effort is sent, for the
 * control's "Default" caption only (never to fill a request). `undefined` when
 * unknown (an org row, an unlisted family): the caption then sits on the
 * Default stop.
 */
export function reasoningEffortDefaultForRow(
  row: Pick<ModelDefinition, "id" | "provider"> &
    Partial<Pick<ModelDefinition, "hosted" | "orgProvider">>,
): ModelReasoningEffort | undefined {
  return defaultReasoningEffort(
    String(row.id),
    reasoningEffortRouteForRow(row),
    String(row.provider),
  );
}

/**
 * Identity a remembered / saved effort is keyed by: the row's selection
 * `selectionKey` when the row can be expressed as one, else its picker row key.
 */
export function reasoningEffortMemoryKey(row: ModelDefinition): string {
  const selection = modelSelectionFromDefinition(row, undefined, "chat");
  return selection ? selectionKey(selection) : modelRowKey(row);
}
