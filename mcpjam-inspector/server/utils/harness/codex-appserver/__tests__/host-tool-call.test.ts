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
      expect(await promises[index]).toEqual(result);
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
          result,
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
    expect(await second).toEqual({ output: "second" });
    turn.pending.get(ids[0])!({ output: "first" });
    expect(await first).toEqual({ output: "first" });
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
});
