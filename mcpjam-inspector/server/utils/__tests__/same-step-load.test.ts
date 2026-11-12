import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { withModelVisibleToolsOnly } from "../same-step-load";

const fnTool = (name: string) => ({
  type: "function" as const,
  name,
  inputSchema: { type: "object" as const },
});

describe("withModelVisibleToolsOnly", () => {
  const sendTools = async (visible: ReadonlySet<string> | null) => {
    const inner = new MockLanguageModelV4({
      doStream: { stream: new ReadableStream({ start: (c) => c.close() }) },
    });
    const wrapped = withModelVisibleToolsOnly(inner, () => visible) as any;
    await wrapped.doStream({
      prompt: [],
      tools: [
        fnTool("search_mcp_tools"),
        fnTool("load_mcp_tools"),
        fnTool("show_squad"),
        { type: "provider", id: "anthropic.web_search", name: "web_search", args: {} },
      ],
    });
    return inner.doStreamCalls[0].tools?.map((tool) => tool.name);
  };

  it("sends the provider only the visible function tools", async () => {
    expect(
      await sendTools(new Set(["search_mcp_tools", "load_mcp_tools"])),
    ).toEqual(["search_mcp_tools", "load_mcp_tools", "web_search"]);
  });

  it("sends every tool when nothing narrows the step", async () => {
    expect(await sendTools(null)).toEqual([
      "search_mcp_tools",
      "load_mcp_tools",
      "show_squad",
      "web_search",
    ]);
  });

  it("returns a model given by id unchanged", () => {
    expect(withModelVisibleToolsOnly("openai/gpt-5", () => null)).toBe(
      "openai/gpt-5",
    );
  });
});
