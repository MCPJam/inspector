import { expect, it } from "vitest";
import { ToolDeclarationCapture } from "../src/mcp-client-manager/tool-declaration-capture.js";
it("retains raw names and output schemas across pages, servers and fresh snapshots", () => {
  const capture = new ToolDeclarationCapture();
  const send = (serverId: string, id: number, cursor?: string) =>
    capture.observe({
      serverId,
      direction: "send",
      message: { id, method: "tools/list", params: { cursor } },
    });
  const receive = (
    serverId: string,
    id: number,
    tools: unknown[],
    nextCursor?: string
  ) =>
    capture.observe({
      serverId,
      direction: "receive",
      message: { id, result: { tools, nextCursor } },
    });
  const tool = {
    name: "same",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  };
  send("a", 1);
  receive("a", 1, [tool], "next");
  expect(capture.read("a")?.capture).toBe("partial");
  send("b", 1);
  receive("b", 1, [tool]);
  send("a", 2, "next");
  receive("a", 2, [tool]);
  expect(capture.read("a")).toEqual({
    capture: "complete",
    tools: [tool, tool],
  });
  expect(capture.read("b")?.tools).toHaveLength(1);
  capture.read("a")!.tools[0].name = "changed";
  expect(capture.read("a")?.tools[0].name).toBe("same");
  send("a", 3);
  receive("a", 3, []);
  expect(capture.read("a")).toEqual({ capture: "complete", tools: [] });
  capture.clear("a");
  expect(capture.read("a")).toBeUndefined();
});
it("does not certify incomplete, ambiguous, failed, or oversized pagination", () => {
  for (const problem of [
    "repeated",
    "overlap",
    "error",
    "cap",
    "invalid",
  ] as const) {
    const capture = new ToolDeclarationCapture();
    const send = (id: number, cursor?: string) =>
      capture.observe({
        serverId: "a",
        direction: "send",
        message: { id, method: "tools/list", params: { cursor } },
      });
    const receive = (id: number, result: unknown) =>
      capture.observe({
        serverId: "a",
        direction: "receive",
        message: { id, result },
      });
    send(1);
    if (problem === "overlap") {
      send(2);
      receive(1, { tools: [{ name: "a" }] });
      receive(2, { tools: [{ name: "b" }] });
    }
    if (problem === "repeated") {
      receive(1, { tools: [{ name: "a" }], nextCursor: "x" });
      send(2, "x");
      receive(2, { tools: [{ name: "b" }], nextCursor: "x" });
    }
    if (problem === "error")
      capture.observe({
        serverId: "a",
        direction: "receive",
        message: { id: 1, error: { code: -1 } },
      });
    if (problem === "cap")
      receive(1, {
        tools: [{ name: "a", description: "x".repeat(4 * 1024 * 1024) }],
      });
    if (problem === "invalid") receive(1, { tools: [{ name: 42 }] });
    expect(capture.read("a")?.capture, problem).toBe("partial");
  }
});
