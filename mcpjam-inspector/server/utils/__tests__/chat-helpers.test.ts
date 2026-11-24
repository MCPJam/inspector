import { describe, it, expect, vi } from "vitest";

// Mock all SDK dependencies that chat-helpers.ts imports
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn() }));
vi.mock("@ai-sdk/azure", () => ({ createAzure: vi.fn() }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: vi.fn() }));
vi.mock("@ai-sdk/google", () => ({ createGoogle: vi.fn() }));
vi.mock("@ai-sdk/mistral", () => ({ createMistral: vi.fn() }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn() }));
vi.mock("@ai-sdk/xai", () => ({ createXai: vi.fn() }));
vi.mock("@openrouter/ai-sdk-provider", () => ({ createOpenRouter: vi.fn() }));
vi.mock("ollama-ai-provider-v2", () => ({ createOllama: vi.fn() }));
vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    isChatGPTAppTool: vi.fn(),
    isMcpAppTool: vi.fn(),
    scrubMetaFromToolResult: vi.fn(),
    scrubMetaAndStructuredContentFromToolResult: vi.fn(),
  };
});

import {
  scrubUnavailableToolHistoryForBackend,
} from "../chat-helpers";
import type { ModelMessage } from "ai";

describe("scrubUnavailableToolHistoryForBackend — tools that come and go", () => {
  function historyOf(toolName: string): ModelMessage[] {
    return [
      { role: "user", content: "add pepperoni" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName,
            input: { topping: "pepperoni" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName,
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
    ] as ModelMessage[];
  }

  it("still scrubs a disconnected server's tool by default", () => {
    const scrubbed = scrubUnavailableToolHistoryForBackend(
      historyOf("gone_server_tool"),
      ["other_tool"],
    );
    expect(scrubbed.some((m) => m.role === "tool")).toBe(false);
  });

  it("keeps the history of a name the caller says comes and goes", () => {
    // A page's tools exist only while that page is open. The model called one
    // on the pizza page and then navigated away; the record of having done so
    // is how it knows the topping is there. An absent tool of any name is
    // refused as "Tool not found" if called again, so keeping the history
    // admits no ungated execution.
    const scrubbed = scrubUnavailableToolHistoryForBackend(
      historyOf("webmcp_add_topping"),
      ["browser_navigate"],
      (name) => name.startsWith("webmcp_"),
    );
    expect(scrubbed).toHaveLength(3);
    expect(scrubbed.some((m) => m.role === "tool")).toBe(true);
  });
});
