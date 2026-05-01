import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildResolvedModelRequestPayload } from "../model-request-payload";

describe("buildResolvedModelRequestPayload", () => {
  it("returns the normalized request payload shape", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ] as any;

    const result = buildResolvedModelRequestPayload({
      systemPrompt: "You are helpful.",
      tools: {},
      messages,
    });

    expect(result).toEqual({
      system: "You are helpful.",
      tools: {},
      messages,
    });
  });

  it("serializes zod-backed tool parameters", () => {
    const result = buildResolvedModelRequestPayload({
      systemPrompt: "",
      tools: {
        greet: {
          description: "Greet someone",
          parameters: z.object({
            name: z.string(),
          }),
        },
      } as any,
      messages: [],
    });

    expect(result.tools.greet).toEqual({
      name: "greet",
      description: "Greet someone",
      inputSchema: expect.objectContaining({
        type: "object",
        properties: {
          name: expect.objectContaining({
            type: "string",
          }),
        },
      }),
    });
  });

  it("passes through AI SDK jsonSchema wrappers", () => {
    const innerJsonSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    };

    const result = buildResolvedModelRequestPayload({
      systemPrompt: "",
      tools: {
        greet: {
          description: "Greet someone",
          parameters: { jsonSchema: innerJsonSchema },
        },
      } as any,
      messages: [],
    });

    expect(result.tools.greet).toEqual({
      name: "greet",
      description: "Greet someone",
      inputSchema: innerJsonSchema,
    });
  });

  it("includes MCP output schemas in raw request payloads", () => {
    const outputSchema = {
      type: "object",
      properties: {
        x: {
          type: "integer",
          description: "Density of seagulls in the sky",
        },
      },
      required: ["x"],
    };

    const result = buildResolvedModelRequestPayload({
      systemPrompt: "",
      tools: {
        get_weather: {
          description: "Get weather",
          inputSchema: {
            jsonSchema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
          _mcpOutputSchema: outputSchema,
        },
      } as any,
      messages: [],
    });

    expect(result.tools.get_weather).toEqual({
      name: "get_weather",
      description: "Get weather",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      outputSchema,
    });
  });

  it("falls back to the empty object schema for raw MCP inputSchema", () => {
    const result = buildResolvedModelRequestPayload({
      systemPrompt: "",
      tools: {
        search: {
          description: "Search things",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      } as any,
      messages: [],
    });

    expect(result.tools.search).toEqual({
      name: "search",
      description: "Search things",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
  });

  it("falls back to the empty object schema when serialization throws", () => {
    const result = buildResolvedModelRequestPayload({
      systemPrompt: "",
      tools: {
        broken: {
          description: "Broken tool",
          parameters: { notZod: true },
        },
      } as any,
      messages: [],
    });

    expect(result.tools.broken).toEqual({
      name: "broken",
      description: "Broken tool",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
  });

  it("defaults to the empty object schema when a tool has no schema", () => {
    const result = buildResolvedModelRequestPayload({
      systemPrompt: "",
      tools: {
        noSchema: {
          description: "No schema tool",
        },
      } as any,
      messages: [],
    });

    expect(result.tools.noSchema).toEqual({
      name: "noSchema",
      description: "No schema tool",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
  });

  it("skips falsy tools", () => {
    const result = buildResolvedModelRequestPayload({
      systemPrompt: "",
      tools: {
        real: {
          description: "Real tool",
        },
        empty: null,
        gone: undefined,
      } as any,
      messages: [],
    });

    expect(result.tools).toEqual({
      real: {
        name: "real",
        description: "Real tool",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    });
  });
});
