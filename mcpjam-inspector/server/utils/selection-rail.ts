/**
 * Which rail a turn runs on — and so who pays for it — decided from the turn's
 * SAVED SELECTION.
 *
 * The rule (PLB-162 Decisions 5 and 8):
 *
 *   | what the row / request carries        | rail       | pays            |
 *   |---------------------------------------|------------|-----------------|
 *   | no selection (unlabelled old row)     | TODAY'S    | hosted-list     |
 *   | `source: "hosted"`                    | `hosted`   | MCPJam credits  |
 *   | `source: "org"`                       | `org`      | the org's key   |
 *   | `source: "local"`                     | `local`    | a local key     |
 *   | stored `source: "legacy"`             | `own-key`  | an own key only |
 *
 * "Today's" path is the hosted-list check (`isHostedModelDefinition`): a row
 * with no selection keeps running exactly where it ran before selections
 * existed, until the old-data script has labelled every row. The guard test
 * (`__tests__/selection-rail.test.ts`) pins that byte-for-byte.
 *
 * A STORED legacy selection is different from no selection: it was written
 * (by a save that found the id outside the hosted catalog, or by the
 * backfill) to mean "own key only". It never reaches the hosted rail, however
 * the id looks — the conversion can move a call off MCPJam credits, never
 * onto them.
 *
 * Pure apart from the warm hosted-catalog cache the no-selection branch reads.
 */
import type { ModelSelection, RequestedModelSelection } from "@mcpjam/sdk";
import { getCanonicalModelId } from "@/shared/types";
import { isHostedModelDefinition } from "../services/hosted-model-catalog.js";
import {
  readRoutingSelection,
  readSelectionOrigin,
  readStoredLegacySelection,
  type ModelSelectionOrigin,
} from "./model-resolution-local.js";

export { readRoutingSelection, readSelectionOrigin, readStoredLegacySelection };
export type { ModelSelectionOrigin };

/**
 * The rail a turn's model call runs on.
 *
 * - `hosted`  — MCPJam's hosted `/stream`, on MCPJam credits.
 * - `org`     — the organization connection the selection names (the backend
 *               `/stream/org`, or the org's local runtime).
 * - `local`   — a provider key on this machine / in this request.
 * - `own-key` — any of the caller's own keys (the org connection for the
 *               model's provider, else a request key) and NEVER MCPJam
 *               credits. Today's non-hosted path, and a stored legacy
 *               selection's only path.
 */
export type TurnRail = "hosted" | "org" | "local" | "own-key";

/** Anything the hosted-list check can classify. */
export type RailModel = {
  id: string | { toString(): string };
  provider?: string;
  hosted?: boolean;
};

/**
 * The selection, only if it is for the model this turn runs. A saved
 * selection belongs to ONE model; a turn on a different model takes today's
 * path for that model instead. Matched on the raw id or its canonical form
 * (a bare hosted id `gpt-5-nano` + `openai` is `openai/gpt-5-nano`).
 */
export function routingSelectionForModel(
  selection: RequestedModelSelection | undefined,
  model: { id: string | { toString(): string }; provider?: string },
): RequestedModelSelection | undefined {
  if (!selection) return undefined;
  const id = String(model.id).trim();
  if (!id) return undefined;
  if (selection.modelId === id) return selection;
  return selection.modelId === getCanonicalModelId(id, model.provider)
    ? selection
    : undefined;
}

/**
 * TODAY's rail for an unlabelled model — the hosted-list check and nothing
 * else. Kept as its own function so the guard test can compare the new
 * decision against it for every bare id.
 */
export function todayTurnRail(model: RailModel): "hosted" | "own-key" {
  return isHostedModelDefinition({
    id: String(model.id),
    ...(model.provider !== undefined ? { provider: model.provider } : {}),
    ...(model.hosted !== undefined ? { hosted: model.hosted } : {}),
  })
    ? "hosted"
    : "own-key";
}

/**
 * THE routing decision. With a selection, its `source` decides; without one,
 * today's hosted-list check does (see the module table).
 */
export function decideTurnRail(args: {
  selection?: RequestedModelSelection;
  model: RailModel;
}): TurnRail {
  const { selection } = args;
  if (!selection) return todayTurnRail(args.model);
  switch (selection.source) {
    case "hosted":
      return "hosted";
    case "org":
      return "org";
    case "local":
      return "local";
    case "legacy":
      return "own-key";
  }
}

/**
 * The model definition every downstream check reads, made to agree with a
 * non-hosted selection: `hosted: false` is the one flag the hosted-list check
 * honours to move a model OFF MCPJam credits, so harness eligibility, skill
 * gating and the dispatch all see the same answer. A hosted selection, or no
 * selection, leaves the definition untouched.
 */
export function withSelectionRouting<T extends { hosted?: boolean }>(
  model: T,
  selection: RequestedModelSelection | undefined,
): T {
  if (!selection || selection.source === "hosted") return model;
  return model.hosted === false ? model : { ...model, hosted: false };
}

/**
 * The selection the backend may be sent as the body's `modelSelection`: a
 * `hosted` one on `/stream`, an `org` one on `/stream/org` and
 * `/stream/org/resolve`. A `local` selection names nothing the backend could
 * resolve, and a legacy one is never sent (`/stream` refuses it).
 */
export function forwardableSelection(
  selection: RequestedModelSelection | undefined,
): ModelSelection | undefined {
  if (!selection) return undefined;
  if (selection.source !== "hosted" && selection.source !== "org") {
    return undefined;
  }
  return selection;
}
