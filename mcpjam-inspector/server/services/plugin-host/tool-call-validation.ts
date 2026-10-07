import { DialectAwareJsonSchemaValidator } from "@mcpjam/sdk";
import { mcpAppToolResultSchema as CallToolResultSchema } from "@mcpjam/sdk/widget-runtime";

/** Ordinary tool schema/result admission shared by native actions and activation. */
export function pluginToolCallValidation(
  tool: {
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  },
  args: Record<string, unknown>,
  error: (kind: "arguments" | "schema" | "limit" | "result") => Error,
) {
  let input: ReturnType<DialectAwareJsonSchemaValidator["getValidator"]>;
  let output:
    ReturnType<DialectAwareJsonSchemaValidator["getValidator"]> | undefined;
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
      new TextEncoder().encode(JSON.stringify(result)).byteLength >
      512 * 1024
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
