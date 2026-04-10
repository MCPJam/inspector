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

    serializedTools[name] = {
      name,
      description: toolRecord.description as string | undefined,
      inputSchema: serializeToolSchema(schema),
    };
  }

  return {
    system: options.systemPrompt,
    tools: serializedTools,
    messages: options.messages,
  };
}
