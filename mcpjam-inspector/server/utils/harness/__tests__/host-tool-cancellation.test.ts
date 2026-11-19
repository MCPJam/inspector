import { expect, it } from "vitest";
import { createHostToolCancellation } from "../host-tool-cancellation";

type Tool = { execute(input: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }): Promise<unknown> };
it("cancels only the named execution and rejects an early cancelled call", async () => {
  const gate = createHostToolCancellation();
  const reached: string[] = [];
  const tool = gate.wrap({ echo: { execute: (_input: unknown, opts: { toolCallId: string; abortSignal?: AbortSignal }) => {
    reached.push(opts.toolCallId);
    return new Promise((_resolve, reject) => opts.abortSignal?.addEventListener("abort", () => reject(opts.abortSignal?.reason), { once: true }));
  } } }).echo as Tool;
  const a = tool.execute({}, { toolCallId: "a" });
  const b = tool.execute({}, { toolCallId: "b" });
  expect(gate.cancel({ type: "mcpjam-host-tool-cancel", toolCallId: "a" })).toBe(true);
  await expect(a).rejects.toThrow(/cancelled/);
  gate.cancel({ type: "mcpjam-host-tool-cancel", toolCallId: "early" });
  await expect(tool.execute({}, { toolCallId: "early" })).rejects.toThrow(/cancelled/);
  expect(reached).toEqual(["a", "b"]);
  gate.cancel({ type: "mcpjam-host-tool-cancel", toolCallId: "b" });
  await expect(b).rejects.toThrow(/cancelled/);
});
