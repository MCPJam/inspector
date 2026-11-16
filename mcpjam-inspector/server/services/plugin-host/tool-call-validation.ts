import { DialectAwareJsonSchemaValidator } from "@mcpjam/sdk";
import { mcpAppToolResultSchema as CallToolResultSchema } from "@mcpjam/sdk/widget-runtime";
import type { PluginInvocationOrigin } from "./invocation.js";

export const PLUGIN_APP_READ_RESULT_BYTES = 12 * 1024 * 1024;
const DEFAULT_RESULT_BYTES = 512 * 1024;

/** Ordinary tool schema/result admission shared by native actions and activation. */
export function pluginToolCallValidation(
  tool: {
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean };
  },
  args: Record<string, unknown>,
  error: (kind: "arguments" | "schema" | "limit" | "result") => Error,
  origin?: PluginInvocationOrigin,
) {
  // Binary file reads can carry base64 in structuredContent. Only an admitted
  // App's read-only call gets that budget; model/action results stay small.
  const resultBytes =
    (origin === "app" || origin === "settings") && tool.annotations?.readOnlyHint === true
      ? PLUGIN_APP_READ_RESULT_BYTES
      : DEFAULT_RESULT_BYTES;
  let input: ReturnType<DialectAwareJsonSchemaValidator["getValidator"]>;
  let output:
    | ReturnType<DialectAwareJsonSchemaValidator["getValidator"]>
    | undefined;
  try {
    const validator = new DialectAwareJsonSchemaValidator();
    input = validator.getValidator(
      tool.inputSchema as Parameters<typeof validator.getValidator>[0],
    );
    output = tool.outputSchema
      ? validator.getValidator(
          tool.outputSchema as Parameters<typeof validator.getValidator>[0],
        )
      : undefined;
  } catch {
    throw error("schema");
  }
  let valid: boolean;
  try {
    valid = input(args).valid;
  } catch {
    throw error("schema");
  }
  if (!valid) throw error("arguments");
  return (result: unknown) => {
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") > resultBytes
    )
      throw error("limit");
    const parsed = CallToolResultSchema.safeParse(result);
    if (
      !parsed.success ||
      (output &&
        ((!parsed.data.structuredContent && !parsed.data.isError) ||
          (parsed.data.structuredContent &&
            !output(parsed.data.structuredContent).valid)))
    )
      throw error("result");
  };
}
