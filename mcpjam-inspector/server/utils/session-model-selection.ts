/**
 * The model selection a chat turn RAN, as the chat session records it.
 *
 * A session stores its last turn's model (`modelId`, overwritten every turn)
 * and, beside it, the selection that turn ran with the effort it actually
 * applied — so a finished session can read "GPT-5.4 Nano · High". The backend
 * keeps it only while it names the turn's `modelId` (its canonical id, or an
 * own-key row's native id), and clears it on a turn that sends none.
 */
import {
  defaultFallbackForPurpose,
  type ModelReasoningEffort,
  type ModelSelection,
  type RequestedModelSelection,
} from "@mcpjam/sdk/browser";
import { todayTurnRail, type RailModel } from "./selection-rail";

/**
 * The turn's routing selection with the applied effort, else — with no saved
 * selection — a hosted one for a model today's rail runs on MCPJam. Undefined
 * for an own-key model with no saved selection: the session then records its
 * `modelId` alone. A legacy selection carries no settings and is sent as-is.
 */
export function ranTurnSelection(args: {
  selection: RequestedModelSelection | undefined;
  model: RailModel;
  reasoningEffort: ModelReasoningEffort | undefined;
}): RequestedModelSelection | undefined {
  const { selection, model, reasoningEffort } = args;
  if (selection?.source === "legacy") return selection;
  const base: ModelSelection | undefined =
    selection ??
    (todayTurnRail(model) === "hosted"
      ? {
          modelId: String(model.id).trim(),
          source: "hosted",
          fallback: defaultFallbackForPurpose("chat"),
        }
      : undefined);
  if (!base) return undefined;
  const { reasoningEffort: _requested, ...rest } = base.settings ?? {};
  void _requested;
  const settings = {
    ...rest,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
  const { settings: _old, ...withoutSettings } = base;
  void _old;
  return Object.keys(settings).length > 0
    ? { ...withoutSettings, settings }
    : withoutSettings;
}
