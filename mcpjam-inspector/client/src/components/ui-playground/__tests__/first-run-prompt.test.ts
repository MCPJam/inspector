import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/client";
import {
  chooseFirstRunPrompt,
  PLAYGROUND_FIRST_RUN_PROMPT,
} from "../first-run-prompt";

function tool(name: string, destructive = false): Tool {
  return {
    name,
    inputSchema: { type: "object" },
    ...(destructive ? { annotations: { destructiveHint: true } } : {}),
  };
}

function tools(count: number): Tool[] {
  return Array.from({ length: count }, (_, index) => tool(`tool_${index + 1}`));
}

describe("chooseFirstRunPrompt", () => {
  it("asks for every tool when the server has ten or fewer", () => {
    expect(chooseFirstRunPrompt(tools(1))).toBe(PLAYGROUND_FIRST_RUN_PROMPT);
    expect(chooseFirstRunPrompt(tools(10))).toBe(
      "Call each of your tools once and summarize what they returned.",
    );
  });

  it("caps the run at ten tools when the server has more", () => {
    expect(chooseFirstRunPrompt(tools(11))).toBe(
      "Call up to 10 of your tools once and summarize what they returned.",
    );
  });

  it("asks about resources and prompts when the server has no tools", () => {
    expect(chooseFirstRunPrompt([])).toBe(
      "List the resources and prompts this server exposes.",
    );
  });

  it("falls back to resources and prompts when every tool is destructive", () => {
    expect(
      chooseFirstRunPrompt([tool("drop_table", true), tool("wipe", true)]),
    ).toBe("List the resources and prompts this server exposes.");
  });

  it("names only the safe tools when some are destructive", () => {
    expect(
      chooseFirstRunPrompt([
        tool("search"),
        tool("delete_issue", true),
        tool("get_issue"),
      ]),
    ).toBe(
      "Call each of these tools once and summarize what they returned: search, get_issue.",
    );
  });

  it("names at most ten safe tools", () => {
    const prompt = chooseFirstRunPrompt([...tools(12), tool("wipe", true)]);
    expect(prompt).toContain("tool_10.");
    expect(prompt).not.toContain("tool_11");
    expect(prompt).not.toContain("wipe");
  });
});
