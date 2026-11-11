import { describe, expect, it } from "vitest";
import { dynamicTool, jsonSchema, type ModelMessage, type ToolSet } from "ai";
import { startProgressiveTurn } from "../src/progressive-discovery/turn.js";
import {
  META_TOOL_LOAD,
  META_TOOL_SEARCH,
} from "../src/progressive-discovery/discovery.js";

function makeTools(count: number): ToolSet {
  const tools: ToolSet = {};
  for (let i = 0; i < count; i++) {
    tools[`tool_${i}`] = dynamicTool({
      description: `Tool number ${i}`,
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => ({ ran: i }),
    });
  }
  return tools;
}

const callOptions = { toolCallId: "call-1", messages: [] };

function execute(tools: ToolSet, name: string, input: unknown) {
  const run = tools[name]?.execute;
  if (!run) throw new Error(`no executable tool ${name}`);
  return run(input as never, callOptions);
}

describe("startProgressiveTurn", () => {
  it("does nothing when the setting is off", () => {
    const tools = makeTools(40);
    expect(
      startProgressiveTurn({ tools, executableTools: tools, mode: false })
    ).toBeUndefined();
  });

  it("on Auto, keeps a small tool set and turns on at 30 tools", () => {
    const few = makeTools(5);
    expect(
      startProgressiveTurn({ tools: few, executableTools: few, mode: "auto" })
    ).toBeUndefined();

    const many = makeTools(30);
    const turn = startProgressiveTurn({
      tools: many,
      executableTools: many,
      mode: "auto",
    });
    expect(turn?.plan.reasons).toEqual(["tool_count>=30"]);
  });

  it("offers only the meta-tools at first and makes the first step a search", () => {
    const tools = makeTools(3);
    const turn = startProgressiveTurn({
      tools,
      executableTools: tools,
      mode: true,
    });
    if (!turn) throw new Error("expected discovery to apply");
    expect(Object.keys(turn.metaTools).sort()).toEqual([
      META_TOOL_LOAD,
      META_TOOL_SEARCH,
    ]);
    expect(turn.prepareStep(0)).toEqual({
      activeTools: [META_TOOL_SEARCH, META_TOOL_LOAD],
      toolChoice: { type: "tool", toolName: META_TOOL_SEARCH },
    });
  });

  it("makes a tool callable on the step after load_mcp_tools loads it", async () => {
    const tools = makeTools(3);
    const turn = startProgressiveTurn({
      tools,
      executableTools: tools,
      mode: true,
    });
    if (!turn) throw new Error("expected discovery to apply");
    turn.prepareStep(0);

    await expect(
      execute(turn.tools, META_TOOL_LOAD, { names: ["tool_1"] })
    ).resolves.toEqual({ loaded: [{ name: "tool_1" }], notFound: [] });
    const next = turn.prepareStep(1);
    expect(next.activeTools).toContain("tool_1");
    expect(next.toolChoice).toBeUndefined();
    await expect(execute(turn.tools, "tool_1", {})).resolves.toEqual({
      ran: 1,
    });
  });

  it("refuses to run a tool that was never loaded", async () => {
    const tools = makeTools(3);
    const turn = startProgressiveTurn({
      tools,
      executableTools: tools,
      mode: true,
    });
    if (!turn) throw new Error("expected discovery to apply");
    turn.prepareStep(0);
    await expect(execute(turn.tools, "tool_2", {})).rejects.toThrow(
      "Tool 'tool_2' is not loaded in this step"
    );
  });

  it("keeps a tool an earlier turn loaded, without forcing another search", () => {
    const tools = makeTools(3);
    const priorMessages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "earlier",
            toolName: META_TOOL_LOAD,
            input: { names: ["tool_2"] },
          },
        ],
      },
    ];
    const turn = startProgressiveTurn({
      tools,
      executableTools: tools,
      mode: true,
      priorMessages,
    });
    if (!turn) throw new Error("expected discovery to apply");
    const first = turn.prepareStep(0);
    expect(first.activeTools).toContain("tool_2");
    expect(first.toolChoice).toBeUndefined();
  });

  it("refuses a server tool that uses a meta-tool's name", () => {
    const tools = { ...makeTools(2), [META_TOOL_SEARCH]: makeTools(1).tool_0 };
    expect(() =>
      startProgressiveTurn({ tools, executableTools: tools, mode: true })
    ).toThrow(/collides with the progressive-discovery meta-tool/);
  });
});
