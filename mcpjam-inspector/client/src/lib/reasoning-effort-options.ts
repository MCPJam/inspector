/**
 * Which reasoning efforts a control may offer for a picker row.
 *
 * A thin adapter over the SDK's one capability table
 * (`supportedReasoningEfforts`): hosted rows read the catalog's list off the
 * row, BYOK / local rows read the per-model provider table, and a harness
 * turn reads the adapter's verified table (empty until verified). Empty means
 * "hide the control" — an unknown capability is never guessed.
 *
 * Pass the CONCRETE route: `org` (runtime not yet known) and `orgCloud` (the
 * cloud stream does not apply an effort yet) both answer "none".
 */
import {
  supportedReasoningEfforts,
  type ModelReasoningEffort,
  type ReasoningEffortRoute,
} from "@mcpjam/sdk/browser";
import type { Harness } from "@mcpjam/sdk/host-config/internal";
import type { ModelDefinition } from "@/shared/types";

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
