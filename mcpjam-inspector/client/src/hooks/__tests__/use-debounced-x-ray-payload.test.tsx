import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import type { UIMessage } from "ai";
import type { ToolDefinition } from "@/lib/apis/mcp-tools-api";

import { useDebouncedXRayPayload } from "../use-debounced-x-ray-payload";

const TOOL_DEFS: Record<string, ToolDefinition> = {
  greet: {
    name: "greet",
    description: "Say hello",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
};

const TOOL_SERVER_MAP: Record<string, string> = {
  greet: "my-server",
};

function makeMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  } as UIMessage;
}

describe("useDebouncedXRayPayload", () => {
  it("returns null payload when messages is empty", () => {
    const { result } = renderHook(() =>
      useDebouncedXRayPayload({
        systemPrompt: "test",
        messages: [],
        toolDefinitions: TOOL_DEFS,
        toolServerMap: TOOL_SERVER_MAP,
      }),
    );

    expect(result.current.payload).toBeNull();
    expect(result.current.hasMessages).toBe(false);
  });

  it("assembles payload from system prompt, tools, and messages", () => {
    const msg = makeMessage("1", "hi");
    const { result } = renderHook(() =>
      useDebouncedXRayPayload({
        systemPrompt: "You are helpful",
        messages: [msg],
        toolDefinitions: TOOL_DEFS,
        toolServerMap: TOOL_SERVER_MAP,
      }),
    );

    expect(result.current.payload?.tools).toEqual({
      greet: {
        name: "greet",
        description: "Say hello",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    });
    expect(result.current.payload?.messages).toEqual([msg]);
    expect(result.current.hasMessages).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("includes tool inventory in system prompt", () => {
    const msg = makeMessage("1", "hi");
    const { result } = renderHook(() =>
      useDebouncedXRayPayload({
        systemPrompt: "You are helpful",
        messages: [msg],
        toolDefinitions: TOOL_DEFS,
        toolServerMap: TOOL_SERVER_MAP,
      }),
    );

    const system = result.current.payload?.system ?? "";
    expect(system).toContain("You are helpful");
    expect(system).toContain("## Connected MCP Tools");
    expect(system).toContain("Server my-server:");
    expect(system).toContain("- greet: Say hello");
  });

  it("clears payload when messages become empty", () => {
    const { result, rerender } = renderHook(
      ({ messages }: { messages: UIMessage[] }) =>
        useDebouncedXRayPayload({
          systemPrompt: "test",
          messages,
          toolDefinitions: TOOL_DEFS,
          toolServerMap: TOOL_SERVER_MAP,
        }),
      { initialProps: { messages: [makeMessage("1", "hi")] } },
    );

    expect(result.current.payload).not.toBeNull();

    rerender({ messages: [] });

    expect(result.current.payload).toBeNull();
  });

  it("shows no tools connected when toolServerMap is empty", () => {
    const { result } = renderHook(() =>
      useDebouncedXRayPayload({
        systemPrompt: undefined,
        messages: [makeMessage("1", "hi")],
        toolDefinitions: {},
        toolServerMap: {},
      }),
    );

    expect(result.current.payload?.system).toContain(
      "No MCP tools are currently connected.",
    );
  });

  it("provides default inputSchema when tool has none", () => {
    const { result } = renderHook(() =>
      useDebouncedXRayPayload({
        systemPrompt: "test",
        messages: [makeMessage("1", "hi")],
        toolDefinitions: {
          bare: { name: "bare", description: "no schema" },
        },
        toolServerMap: { bare: "s1" },
      }),
    );

    expect(result.current.payload?.tools.bare.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });
});
