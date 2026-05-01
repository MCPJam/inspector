import { z } from "zod";
import type { ToolSet } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ResolvedModelRequestPayload } from "@/shared/model-request-payload";

const DEFAULT_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function serializeToolSchema(schema: unknown): Record<string, unknown> {
  if (!schema) {
    return DEFAULT_INPUT_SCHEMA;
  }

  if (typeof schema === "object" && schema !== null && "jsonSchema" in schema) {
    return (schema as { jsonSchema: Record<string, unknown> }).jsonSchema;
  }

  try {
    return z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>;
  } catch {
    return DEFAULT_INPUT_SCHEMA;
  }
}

function serializeOptionalJsonSchema(
  schema: unknown
): Record<string, unknown> | undefined {
  if (!schema) {
    return undefined;
  }

  if (typeof schema === "object" && schema !== null && "jsonSchema" in schema) {
    return (schema as { jsonSchema: Record<string, unknown> }).jsonSchema;
  }

  try {
    return z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>;
  } catch {
    if (
      typeof schema === "object" &&
      schema !== null &&
      !Array.isArray(schema)
    ) {
      return schema as Record<string, unknown>;
    }

    return undefined;
  }
}

export function buildResolvedModelRequestPayload(options: {
  systemPrompt: string;
  tools: ToolSet;
  messages: ModelMessage[];
}): ResolvedModelRequestPayload {
  const serializedTools: ResolvedModelRequestPayload["tools"] = {};

  for (const [name, tool] of Object.entries(options.tools)) {
    if (!tool) {
      continue;
    }

    const toolRecord = tool as Record<string, unknown>;
    const schema = toolRecord.parameters ?? toolRecord.inputSchema;
    const outputSchema = serializeOptionalJsonSchema(
      toolRecord.outputSchema ?? toolRecord._mcpOutputSchema
    );

    serializedTools[name] = {
      name,
      description: toolRecord.description as string | undefined,
      inputSchema: serializeToolSchema(schema),
      ...(outputSchema ? { outputSchema } : {}),
    };
  }

  return {
    system: options.systemPrompt,
    tools: serializedTools,
    messages: options.messages,
  };
}
