import { describe, expect, it, vi } from "vitest";
import type { BridgeEvent, BridgeTurn } from "@ai-sdk/harness/bridge";
import { callHostTool } from "../bridge/host-tool-call";

type ToolResult = Awaited<ReturnType<BridgeTurn["requestToolResult"]>>;

function activeTurn() {
  const events: BridgeEvent[] = [];
  const pending = new Map<string, (result: ToolResult) => void>();
  const requestToolResult = vi.fn(
    (input: Parameters<BridgeTurn["requestToolResult"]>[0]) => {
      const id = typeof input === "string" ? input : input.toolCallId;
      return new Promise<ToolResult>((resolve) => pending.set(id, resolve));
    },
  );
  return {
    active: {
      turn: {
        emit: (event: BridgeEvent) => events.push(event),
        requestToolResult,
      },
      aliasToCanonical: new Map([["alias", "server__tool"]]),
    },
    events,
    pending,
  };
}

describe("retained host tool call identities", () => {
  it("keeps identical calls distinct across turns and matches each result to its call", async () => {
    const turns = [activeTurn(), activeTurn()];
    const promises = turns.map(({ active }) =>
      callHostTool(active, { toolName: "alias", input: { value: 1 } }),
    );
    const ids = turns.map(({ pending }) => [...pending.keys()][0]);
    expect(new Set(ids).size).toBe(2);
    for (const [index, turn] of turns.entries()) {
      const result = { output: { turn: index } };
      turn.pending.get(ids[index])!(result);
      expect(await promises[index]).toEqual(result.output);
      expect(turn.events).toEqual([
        {
          type: "tool-call",
          toolCallId: ids[index],
          toolName: "server__tool",
          input: '{"value":1}',
          providerExecuted: false,
        },
        {
          type: "tool-result",
          toolCallId: ids[index],
          toolName: "server__tool",
          result: result.output,
        },
      ]);
    }
  });

  it("keeps concurrent identical calls independent when results arrive out of order", async () => {
    const turn = activeTurn();
    const first = callHostTool(turn.active, { toolName: "alias", input: {} });
    const second = callHostTool(turn.active, { toolName: "alias", input: {} });
    const ids = [...turn.pending.keys()];
    expect(ids).toHaveLength(2);
    turn.pending.get(ids[1])!({ output: "second" });
    expect(await second).toEqual("second");
    turn.pending.get(ids[0])!({ output: "first" });
    expect(await first).toEqual("first");
    expect(
      turn.events
        .filter((event) => event.type === "tool-result")
        .map((event) => event.toolCallId),
    ).toEqual([ids[1], ids[0]]);
  });

  it("refuses calls outside an active turn", async () => {
    await expect(
      callHostTool(undefined, { toolName: "alias", input: {} }),
    ).rejects.toThrow("no active turn");
  });

  it.each([null, undefined])(
    "preserves a %s output without returning the bridge envelope",
    async (output) => {
      const turn = activeTurn();
      const pending = callHostTool(turn.active, {
        toolName: "alias",
        input: {},
      });
      const id = [...turn.pending.keys()][0];
      const response: ToolResult = { output };
      turn.pending.get(id)!(response);
      expect(await pending).toBe(output);
      expect(turn.events.at(-1)).toMatchObject({
        type: "tool-result",
        toolCallId: id,
        result: null,
      });
    },
  );

  it("relays only the model-facing output and leaves result metadata out", async () => {
    const turn = activeTurn();
    const pending = callHostTool(turn.active, { toolName: "alias", input: {} });
    const id = [...turn.pending.keys()][0];
    const output = { content: [{ type: "text", text: "units: mm" }] };
    const response: ToolResult = {
      output,
      isError: false,
      toolResult: {
        type: "tool-result",
        toolCallId: id,
        toolName: "server__tool",
        output: { type: "json", value: { internal: "metadata" } },
      },
    };
    turn.pending.get(id)!(response);
    expect(await pending).toBe(output);
    expect(turn.events.at(-1)).toEqual({
      type: "tool-result",
      toolCallId: id,
      toolName: "server__tool",
      result: output,
      isError: false,
    });
  });

  it.each([undefined, false])(
    "preserves an MCP error when the bridge error flag is %s",
    async (isError) => {
      const turn = activeTurn();
      const pending = callHostTool(turn.active, {
        toolName: "alias",
        input: {},
      });
      const id = [...turn.pending.keys()][0];
      const output = {
        content: [{ type: "text", text: "server refusal" }],
        isError: true,
      };
      const response: ToolResult = { output, isError };
      turn.pending.get(id)!(response);
      expect(await pending).toEqual(output);
      expect(turn.events.at(-1)).toEqual({
        type: "tool-result",
        toolCallId: id,
        toolName: "server__tool",
        result: output,
        isError: true,
      });
    },
  );

  it.each([
    {
      name: "without content",
      output: { isError: true, meaning: "application data" },
    },
    {
      name: "with non-MCP content",
      output: { content: ["application data"], isError: true },
    },
  ])(
    "does not interpret an isError field in generic JSON $name as an MCP error",
    async ({ output }) => {
      const turn = activeTurn();
      const pending = callHostTool(turn.active, {
        toolName: "alias",
        input: {},
      });
      const id = [...turn.pending.keys()][0];
      const response: ToolResult = { output };
      turn.pending.get(id)!(response);
      expect(await pending).toBe(output);
      expect(turn.events.at(-1)).toEqual({
        type: "tool-result",
        toolCallId: id,
        toolName: "server__tool",
        result: output,
      });
    },
  );

  it.each([
    {
      output: "permission denied",
      content: [{ type: "text", text: "permission denied" }],
    },
    {
      output: { reason: "denied" },
      content: [{ type: "text", text: '{"reason":"denied"}' }],
    },
    { output: null, content: [{ type: "text", text: "null" }] },
    { output: undefined, content: [{ type: "text", text: "null" }] },
    {
      output: { content: [{ type: "text", text: "server refusal" }] },
      content: [{ type: "text", text: "server refusal" }],
    },
  ])(
    "preserves a failed bridge result in the terminal event and MCP reply ($output)",
    async ({ output, content }) => {
      const turn = activeTurn();
      const pending = callHostTool(turn.active, {
        toolName: "alias",
        input: {},
      });
      const id = [...turn.pending.keys()][0];
      const response: ToolResult = { output, isError: true };
      turn.pending.get(id)!(response);
      expect(await pending).toMatchObject({ content, isError: true });
      expect(turn.events.at(-1)).toEqual({
        type: "tool-result",
        toolCallId: id,
        toolName: "server__tool",
        result: output ?? null,
        isError: true,
      });
    },
  );
});
