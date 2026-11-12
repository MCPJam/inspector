/**
 * A model may load a tool with `load_mcp_tools` and call it in the same step,
 * before it has seen that tool's schema. Both chat engines let such a call run
 * when the guessed input fits the schema: the hosted path in
 * `mcpjam-stream-handler.ts`, the local AI SDK path in `direct-chat-turn.ts`.
 */
import { wrapLanguageModel, type LanguageModel } from "ai";
import { DialectAwareJsonSchemaValidator } from "@mcpjam/sdk";

/**
 * Whether `input` is an object its tool's JSON Schema accepts. The check for a
 * call the model made before it saw that schema: such a call runs only when
 * its guess is right.
 */
export function inputMatchesSchema(
  schema: Record<string, unknown>,
  input: unknown,
): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  try {
    // An unknown dialect is not validated at all, so it must not admit a guess.
    return new DialectAwareJsonSchemaValidator({
      onUnknownDialect: () => {
        throw new Error("Unsupported JSON Schema dialect");
      },
    }).getValidator(
      schema as Parameters<DialectAwareJsonSchemaValidator["getValidator"]>[0],
    )(input).valid;
  } catch {
    return false;
  }
}

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
