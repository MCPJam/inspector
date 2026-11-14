import { createBenchmarkArtifactLedger } from "../artifact-ledger.js";
import { describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { createToolPolicyGate } from "../tool-policy-gate.js";
import {
  guardEvalViewTools,
  evalWidgetServerCall,
} from "../view-tool-policy.js";
import { mergeViewToolEvidence } from "../view-tool-evidence.js";

const options = { toolCallId: "call", messages: [], context: undefined };
describe("eval view tools", () => {
  it.each([
    [{ mode: "readOnly" as const }, true],
    [{ mode: "readOnly" as const, allow: ["view:move"] }, false],
    [{ mode: "readOnly" as const, allow: ["view:move"], deny: ["view:move"] }, true],
    [{ mode: "default" as const, deny: ["view:move"] }, true],
    [{ mode: "default" as const, deny: ["move"] }, false],
  ])(
    "checks the qualified policy name before invoking the view: %j",
    async (policy, blocked) => {
      const execute = vi.fn(async () => ({ content: [] }));
      const gate = createToolPolicyGate({ policy, annotations: new Map() });
      const tools = guardEvalViewTools(
        {
          widget_call_tool: tool({
            inputSchema: z.record(z.string(), z.unknown()),
            execute,
          }),
        },
        gate,
      );
      const result = await tools.widget_call_tool.execute!(
        { viewId: "A", name: "move", arguments: {} },
        options,
      );
      expect(execute).toHaveBeenCalledTimes(blocked ? 0 : 1);
      expect(result).toMatchObject(
        blocked ? { mcpjamPolicyBlock: true } : { content: [] },
      );
    },
  );
  it("keeps a qualified view allow from allowing the same server tool", async () => {
    const executeTool = vi.fn(async () => ({ content: [] }));
    const gate = createToolPolicyGate({
      policy: { mode: "readOnly", allow: ["view:move"] },
      annotations: new Map(),
    });
    expect(await evalWidgetServerCall(gate, { executeTool })("server", "move", {}))
      .toHaveProperty("mcpjamPolicyBlock", true);
    expect(executeTool).not.toHaveBeenCalled();
  });
  it("keeps a server allow from allowing the same view tool", async () => {
    const execute = vi.fn(async () => ({ content: [] }));
    const gate = createToolPolicyGate({
      policy: { mode: "readOnly", allow: ["move"] },
      annotations: new Map(),
    });
    const guarded = guardEvalViewTools({
      widget_call_tool: tool({ inputSchema: z.record(z.string(), z.unknown()), execute }),
    }, gate);
    expect(await guarded.widget_call_tool.execute!(
      { viewId: "A", name: "move", arguments: {} }, options,
    )).toHaveProperty("mcpjamPolicyBlock", true);
    expect(execute).not.toHaveBeenCalled();
  });
  it("enforces the pinned write manifest even for an allow-listed view tool", async () => {
    const execute = vi.fn(async () => ({ content: [] }));
    const gate = createToolPolicyGate({
      policy: { mode: "default", allow: ["view:move"] },
      annotations: new Map(),
      sideEffectGate: {
        sideEffects: undefined,
        benchmarkRunId: "run",
        iteration: 0,
        ledger: createBenchmarkArtifactLedger(),
        requireManifest: true,
      },
    });
    const tools = guardEvalViewTools(
      {
        widget_call_tool: tool({
          inputSchema: z.record(z.string(), z.unknown()),
          execute,
        }),
      },
      gate,
    );
    expect(
      await tools.widget_call_tool.execute!(
        { viewId: "A", name: "move", arguments: {} },
        options,
      ),
    ).toHaveProperty("mcpjamPolicyBlock", true);
    expect(execute).not.toHaveBeenCalled();
    expect(gate.blocks[0].reason).toBe("sideEffectManifestMissing");
  });
  it("applies server annotations and deny rules to calls with no model action", async () => {
    const executeTool = vi.fn(async () => ({ content: [] }));
    const gate = createToolPolicyGate({
      policy: { mode: "readOnly", deny: ["delete"] },
      annotations: new Map([["server:read", { readOnlyHint: true }]]),
    });
    const call = evalWidgetServerCall(gate, { executeTool });
    expect(await call("server", "delete", {})).toHaveProperty(
      "mcpjamPolicyBlock",
      true,
    );
    expect(await call("server", "unknown", {})).toHaveProperty(
      "mcpjamPolicyBlock",
      true,
    );
    await call("server", "read", {});
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith("server", "read", {});
  });
  it("counts only dispatch records, including unsuccessful executions, by raw name", () => {
    const calls = mergeViewToolEvidence(
      [
        [
          { toolName: "widget_tools" },
          { toolName: "widget_call_tool", arguments: { name: "stale" } },
          { toolName: "read" },
        ],
      ],
      [
        {
          promptIndex: 0,
          call: {
            viewId: "A",
            serverId: "server",
            rawName: "move",
            arguments: { square: "e4" },
            ok: false,
            followUps: [],
            widgetToolCalls: [
              {
                name: "delete",
                args: {},
                ok: true,
                elapsedMs: 1,
                result: { mcpjamPolicyBlock: true },
              },
            ],
          },
        },
      ],
    );
    expect(calls).toEqual([
      [{ toolName: "read" }, { toolName: "move", arguments: { square: "e4" } }],
    ]);
  });
});
