import { describe, expect, it } from "vitest";
import { executeToolCallsFromMessages } from "../http-tool-calls";

function suspendSignal(): Error {
  return Object.assign(new Error("MRTR operation suspended"), {
    code: "MRTR_SUSPENDED",
  });
}

function assistantWithCalls(calls: Array<{ id: string; name: string }>) {
  return {
    role: "assistant",
    content: calls.map((c) => ({
      type: "tool-call",
      toolCallId: c.id,
      toolName: c.name,
      input: {},
    })),
  } as any;
}

function toolResultIds(messages: any[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (m?.role !== "tool") continue;
    for (const p of m.content) if (p.type === "tool-result") ids.push(p.toolCallId);
  }
  return ids;
}

describe("executeToolCallsFromMessages — hosted MRTR suspend", () => {
  it("propagates the suspend signal instead of capturing it as an error tool-result", async () => {
    const tools = {
      toolA: {
        _serverId: "srv",
        execute: async () => {
          throw suspendSignal();
        },
      },
    };
    const messages = [assistantWithCalls([{ id: "a", name: "toolA" }])];

    await expect(
      executeToolCallsFromMessages(messages, { tools: tools as any }),
    ).rejects.toMatchObject({ code: "MRTR_SUSPENDED" });

    // The suspended call must remain UNRESOLVED (no phantom error-text result).
    expect(toolResultIds(messages)).toEqual([]);
  });

  it("splices completed sibling results before propagating the suspend (exactly-once)", async () => {
    const tools = {
      toolA: {
        _serverId: "srv",
        execute: async () => ({ content: [{ type: "text", text: "done A" }] }),
      },
      toolB: {
        _serverId: "srv",
        execute: async () => {
          throw suspendSignal();
        },
      },
    };
    const messages = [
      assistantWithCalls([
        { id: "a", name: "toolA" },
        { id: "b", name: "toolB" },
      ]),
    ];

    await expect(
      executeToolCallsFromMessages(messages, { tools: tools as any }),
    ).rejects.toMatchObject({ code: "MRTR_SUSPENDED" });

    // Sibling A's side effect ran → its result is preserved so resume does NOT
    // re-execute it; only the suspended B stays unresolved.
    expect(toolResultIds(messages)).toEqual(["a"]);
  });

  it("preserves sibling splice under sequential execution too", async () => {
    const tools = {
      toolA: {
        _serverId: "srv",
        execute: async () => ({ content: [{ type: "text", text: "done A" }] }),
      },
      toolB: {
        _serverId: "srv",
        execute: async () => {
          throw suspendSignal();
        },
      },
    };
    const messages = [
      assistantWithCalls([
        { id: "a", name: "toolA" },
        { id: "b", name: "toolB" },
      ]),
    ];

    await expect(
      executeToolCallsFromMessages(messages, {
        tools: tools as any,
        parallelToolExecution: false,
      }),
    ).rejects.toMatchObject({ code: "MRTR_SUSPENDED" });

    expect(toolResultIds(messages)).toEqual(["a"]);
  });

  it("still captures ordinary tool errors as error-text (suspend is the only new escape)", async () => {
    const tools = {
      toolA: {
        _serverId: "srv",
        execute: async () => {
          throw new Error("ordinary failure");
        },
      },
    };
    const messages = [assistantWithCalls([{ id: "a", name: "toolA" }])];

    const results = await executeToolCallsFromMessages(messages, {
      tools: tools as any,
    });
    const part = (results[0] as any).content[0];
    expect(part.output.type).toBe("error-text");
  });
});
