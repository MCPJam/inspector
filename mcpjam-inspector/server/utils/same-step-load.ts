/**
 * A model may load a tool with `load_mcp_tools` and call it in the same step.
 * Both chat engines let such a call run: the hosted path in
 * `mcpjam-stream-handler.ts`, the local AI SDK path in `direct-chat-turn.ts`.
 */
import { wrapLanguageModel, type LanguageModel } from "ai";

/**
 * Send the provider only the function tools in `getVisible()`.
 *
 * The AI SDK checks each tool call against the step's `activeTools`, the same
 * list it sends the model, so a tool loaded mid-step is refused before any
 * code of ours sees the call. With this, `activeTools` can name every tool
 * while the model is still shown only the loaded ones. `null` sends all, and
 * a model given by id is returned as is.
 */
export function withModelVisibleToolsOnly(
  model: LanguageModel,
  getVisible: () => ReadonlySet<string> | null,
): LanguageModel {
  if (typeof model === "string") return model;
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: async ({ params }) => {
        const visible = getVisible();
        if (!visible || !params.tools) return params;
        return {
          ...params,
          tools: params.tools.filter(
            (tool) => tool.type !== "function" || visible.has(tool.name),
          ),
        };
      },
    },
  });
}
