import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deliverToolData,
  settleToolData,
  type ToolDataBridge,
} from "../tool-data-delivery";

const VALID_RESULT = {
  content: [{ type: "text", text: "Scene saved" }],
  structuredContent: { label: "scene-42" },
};
// What the Claude Code adapter hands the widget hook for an MCP tool: text
// content flattened to a string, either bare or where the content array goes.
const CLAUDE_FLATTENED_TEXT = "Shared the scene at https://example.test/s/42";
const CLAUDE_STRING_CONTENT = { content: CLAUDE_FLATTENED_TEXT };

function fakeBridge(overrides: Partial<ToolDataBridge> = {}) {
  const sent: string[] = [];
  const bridge: ToolDataBridge = {
    sendToolInput: vi.fn(async () => {
      sent.push("input");
    }),
    sendToolResult: vi.fn(async () => {
      sent.push("result");
    }),
    ...overrides,
  };
  return { bridge, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("deliverToolData", () => {
  it("accepts a valid result after sending the input, then the result", async () => {
    const { bridge, sent } = fakeBridge();
    const delivery = await deliverToolData(bridge, {
      toolInput: { id: 42 },
      toolOutput: VALID_RESULT,
    });
    expect(delivery).toEqual({ result: "accepted", problems: [] });
    expect(sent).toEqual(["input", "result"]);
    expect(bridge.sendToolResult).toHaveBeenCalledWith(VALID_RESULT);
  });

  it("has no verdict when there is no result to send", async () => {
    const { bridge, sent } = fakeBridge();
    const delivery = await deliverToolData(bridge, { toolInput: { id: 42 } });
    expect(delivery).toEqual({ problems: [] });
    expect(sent).toEqual(["input"]);
  });

  it.each([
    ["bare flattened text", CLAUDE_FLATTENED_TEXT, "result: expected object, received string"],
    ["string content", CLAUDE_STRING_CONTENT, "content: expected array, received string"],
  ])(
    "rejects Claude's %s, still sends it, and names only the schema path",
    async (_label, toolOutput, detail) => {
      const { bridge, sent } = fakeBridge();
      const delivery = await deliverToolData(bridge, { toolOutput });
      expect(delivery.result).toBe("rejected");
      expect(delivery.problems).toEqual([
        `The widget rejected this tool result because it does not match the MCP Apps tool result format (${detail}).`,
      ]);
      // Sent as a real host would, so the widget's own reaction is on record.
      expect(sent).toEqual(["result"]);
      expect(bridge.sendToolResult).toHaveBeenCalledWith(toolOutput);
      expect(delivery.problems.join(" ")).not.toContain("example.test");
    },
  );

  it("records a failed result send instead of dropping it", async () => {
    const { bridge } = fakeBridge({
      sendToolResult: vi.fn(async () => {
        throw new Error("Failed to execute 'postMessage' on 'Window'");
      }),
    });
    const delivery = await deliverToolData(bridge, {
      toolInput: { id: 42 },
      toolOutput: VALID_RESULT,
    });
    expect(delivery).toEqual({
      result: "send_failed",
      problems: [
        "The tool result could not be sent to the widget (Failed to execute 'postMessage' on 'Window').",
      ],
    });
  });

  it("keeps a rejected verdict and also records its failed send", async () => {
    const { bridge } = fakeBridge({
      sendToolResult: vi.fn(async () => {
        throw new Error("transport closed");
      }),
    });
    const delivery = await deliverToolData(bridge, {
      toolOutput: CLAUDE_STRING_CONTENT,
    });
    expect(delivery.result).toBe("rejected");
    expect(delivery.problems).toHaveLength(2);
    expect(delivery.problems[1]).toBe(
      "The tool result could not be sent to the widget (transport closed).",
    );
  });

  it("records a failed input send and still delivers the result", async () => {
    const { bridge, sent } = fakeBridge({
      sendToolInput: vi.fn(async () => {
        throw new Error("transport closed");
      }),
    });
    const delivery = await deliverToolData(bridge, {
      toolInput: { id: 42 },
      toolOutput: VALID_RESULT,
    });
    expect(delivery).toEqual({
      result: "accepted",
      problems: [
        "The tool input could not be sent to the widget (transport closed).",
      ],
    });
    expect(sent).toEqual(["result"]);
  });

  it("bounds a long send error", async () => {
    const { bridge } = fakeBridge({
      sendToolResult: vi.fn(async () => {
        throw new Error("x".repeat(1_000));
      }),
    });
    const delivery = await deliverToolData(bridge, { toolOutput: VALID_RESULT });
    expect(delivery.problems[0].length).toBeLessThan(400);
  });
});

describe("settleToolData", () => {
  it("returns a delivery that settles within the budget", async () => {
    const delivery = { result: "accepted" as const, problems: [] };
    await expect(settleToolData(Promise.resolve(delivery), 1_000)).resolves.toBe(
      delivery,
    );
  });

  it("fails a delivery still pending at the render deadline", async () => {
    vi.useFakeTimers();
    const settled = settleToolData(new Promise(() => {}), 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(settled).resolves.toEqual({
      problems: [
        "The tool data was still being sent to the widget when the render timed out.",
      ],
    });
  });

  it("gives sends a floor when the handshake used up the budget", async () => {
    vi.useFakeTimers();
    let settled = false;
    void settleToolData(new Promise(() => {}), -50).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(true);
  });
});
