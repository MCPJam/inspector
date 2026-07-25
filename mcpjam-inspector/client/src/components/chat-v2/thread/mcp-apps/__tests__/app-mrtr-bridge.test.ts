import { describe, it, expect, vi } from "vitest";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  registerHostBridgeHandlers,
  type HostBridgeCallbacks,
  type RegisterHostBridgeHandlersOptions,
} from "../host-app-bridge";

/**
 * PR7 (§12.6) — App-initiated tool calls through the MRTR (`input_required`)
 * driver.
 *
 * An MCP App's `bridge.oncalltool` is dispatched to `callbacks.onCallTool`,
 * which on the local surface is the driver-backed `callTool` (→
 * `/api/mcp/tools/execute` → `manager.executeTool`). When the tool returns
 * `input_required`, the SDK driver collects each round through the shared
 * elicitation dialog and RETRIES the original operation SERVER-SIDE, inside a
 * single `onCallTool` invocation. These tests lock the two load-bearing PR7
 * guarantees at the App boundary:
 *
 *   1. Tool-visibility enforcement is preserved across the retry: the
 *      model-only gate is checked ONCE before dispatch, and because the whole
 *      round loop lives inside `onCallTool`, the App can never reach a
 *      different (gated) tool on a later round — the loop cannot bypass the
 *      advertised-subset gate.
 *   2. Only the FINAL result is returned over the App bridge; the interim
 *      `input_required` is never surfaced to the widget nor as the app-tool
 *      invocation output.
 *
 * `onCallTool` is modeled as an async function that performs its own multiple
 * `input_required` rounds internally (exactly as the server-side driver does)
 * and resolves with the terminal result — so the bridge sees one atomic call.
 */

type StubBridge = {
  oncalltool?: (...args: unknown[]) => unknown;
  sendToolCancelled: ReturnType<typeof vi.fn>;
  teardownResource: ReturnType<typeof vi.fn>;
  getAppCapabilities: ReturnType<typeof vi.fn>;
};

function makeStubBridge(): StubBridge {
  return {
    sendToolCancelled: vi.fn().mockResolvedValue(undefined),
    teardownResource: vi.fn().mockResolvedValue({}),
    getAppCapabilities: vi.fn().mockReturnValue(undefined),
  };
}

const ALL_CAPS = {
  message: true,
  openLinks: true,
  serverTools: true,
  serverResources: true,
  logging: true,
  updateModelContext: true,
  downloadFile: true,
} as RegisterHostBridgeHandlersOptions["effectiveHostCapabilities"];

function register(
  bridge: StubBridge,
  opts: Partial<RegisterHostBridgeHandlersOptions> & {
    callbacks?: HostBridgeCallbacks;
  } = {},
) {
  registerHostBridgeHandlers(bridge as unknown as AppBridge, {
    effectiveHostCapabilities: opts.effectiveHostCapabilities ?? ALL_CAPS,
    getMatrix: opts.getMatrix,
    getToolMetadata: opts.getToolMetadata,
    getToolCallId: opts.getToolCallId ?? (() => "parent-1"),
    nextInvocationSequence: opts.nextInvocationSequence ?? (() => 1),
    callbacks: opts.callbacks ?? {},
  });
}

const callTool = (bridge: StubBridge, name: string, args: unknown) =>
  (bridge.oncalltool as (p: unknown, e: unknown) => Promise<unknown>)(
    { name, arguments: args },
    {},
  );

/**
 * A driver-backed `onCallTool` stand-in: it simulates the SERVER-SIDE MRTR loop
 * (the real `manager.executeTool`) by iterating `rounds` collectors before
 * resolving with `final`. It records how the interim state was observed so a
 * test can assert the interim never escaped.
 */
function makeDriverBackedOnCallTool(opts: {
  rounds: number;
  final: unknown;
  onRound?: (round: number) => void;
}) {
  const interimResults: unknown[] = [];
  const fn = vi.fn(async (_name: string, _args: Record<string, unknown>) => {
    for (let round = 0; round < opts.rounds; round++) {
      // The driver would emit an interim `input_required` result and collect
      // input here; it is consumed internally and NEVER returned.
      interimResults.push({ resultType: "input_required", round });
      opts.onRound?.(round);
      // (input collection happens over the dialog rail; modeled as resolved)
      await Promise.resolve();
    }
    return opts.final;
  });
  return { fn, interimResults };
}

describe("App-initiated MRTR — visibility gate covers the whole operation", () => {
  it("rejects a model-only tool before any dispatch, so no round can run", async () => {
    const bridge = makeStubBridge();
    const { fn: onCallTool } = makeDriverBackedOnCallTool({
      rounds: 3,
      final: { content: [{ type: "text", text: "should never get here" }] },
    });
    register(bridge, {
      getToolMetadata: (name) =>
        name === "delete_account" ? { ui: { visibility: ["model"] } } : {},
      callbacks: { onCallTool },
    });

    await expect(callTool(bridge, "delete_account", {})).rejects.toThrow(
      /not callable by apps/,
    );
    // The retry loop lives inside onCallTool; gating BEFORE dispatch means the
    // op — and therefore every would-be retry round — never starts.
    expect(onCallTool).not.toHaveBeenCalled();
    expect(bridge.sendToolCancelled).toHaveBeenCalledTimes(1);
  });

  it("dispatches an app-visible tool exactly once even across multiple rounds", async () => {
    const bridge = makeStubBridge();
    const rounds: number[] = [];
    const final = { content: [{ type: "text", text: "done" }] };
    const { fn: onCallTool } = makeDriverBackedOnCallTool({
      rounds: 2,
      final,
      onRound: (r) => rounds.push(r),
    });
    register(bridge, {
      // default visibility => model + app (callable by apps)
      getToolMetadata: () => ({}),
      callbacks: { onCallTool },
    });

    const out = await callTool(bridge, "search", { q: 1 });
    // ONE bridge dispatch drives the whole multi-round op (loop is server-side).
    expect(onCallTool).toHaveBeenCalledTimes(1);
    expect(rounds).toEqual([0, 1]);
    expect(out).toBe(final);
  });
});

describe("App-initiated MRTR — only the final result crosses the bridge", () => {
  it("returns the terminal result, never an interim input_required", async () => {
    const bridge = makeStubBridge();
    const final = { content: [{ type: "text", text: "FINAL" }] };
    const { fn: onCallTool, interimResults } = makeDriverBackedOnCallTool({
      rounds: 2,
      final,
    });
    register(bridge, {
      getToolMetadata: () => ({}),
      callbacks: { onCallTool },
    });

    const out = await callTool(bridge, "book", {});
    // Interim input_required rounds happened internally...
    expect(interimResults.length).toBe(2);
    expect(interimResults.every((r: any) => r.resultType === "input_required")).toBe(
      true,
    );
    // ...but the widget only ever sees the terminal result.
    expect(out).toBe(final);
    expect(out).not.toMatchObject({ resultType: "input_required" });
  });

  it("surfaces running → success with the FINAL result to the invocation lifecycle", async () => {
    const bridge = makeStubBridge();
    const final = { content: [{ type: "text", text: "FINAL" }] };
    const updates: Array<{ status: string; output?: unknown }> = [];
    const { fn: onCallTool } = makeDriverBackedOnCallTool({ rounds: 1, final });
    register(bridge, {
      getToolMetadata: () => ({}),
      callbacks: {
        onCallTool,
        onAppToolInvocation: (u) => updates.push(u),
      },
    });

    await callTool(bridge, "book", {});
    expect(updates.map((u) => u.status)).toEqual(["running", "success"]);
    // The success payload is the terminal result, not an interim round.
    expect(updates[1].output).toBe(final);
  });
});

describe("App-initiated MRTR — decline/cancel yields a terminal outcome", () => {
  it("delivers the server's terminal result after a declined round (no hang, no interim)", async () => {
    const bridge = makeStubBridge();
    // The driver retries with the decline response; the server returns a
    // terminal (here: error-flavored) CallToolResult, which is a proper
    // terminal outcome the App must receive.
    const terminal = { content: [{ type: "text", text: "cancelled" }], isError: true };
    const onCallTool = vi.fn(async () => {
      // one input_required round, user declines, server finalizes.
      await Promise.resolve();
      return terminal;
    });
    const updates: Array<{ status: string; output?: unknown }> = [];
    register(bridge, {
      getToolMetadata: () => ({}),
      callbacks: { onCallTool, onAppToolInvocation: (u) => updates.push(u) },
    });

    const out = await callTool(bridge, "checkout", {});
    expect(out).toBe(terminal);
    // A terminal isError result still resolves the request (App decides how to
    // render it) — it is NOT thrown and NOT an interim.
    expect(updates.map((u) => u.status)).toEqual(["running", "success"]);
    expect(bridge.sendToolCancelled).not.toHaveBeenCalled();
  });

  it("propagates a hard driver failure as a thrown error + cancelled (round zero not restarted)", async () => {
    const bridge = makeStubBridge();
    const onCallTool = vi.fn().mockRejectedValue(new Error("transport lost"));
    const updates: Array<{ status: string; errorText?: string }> = [];
    register(bridge, {
      getToolMetadata: () => ({}),
      callbacks: { onCallTool, onAppToolInvocation: (u) => updates.push(u) },
    });

    await expect(callTool(bridge, "checkout", {})).rejects.toThrow(
      "transport lost",
    );
    expect(updates.map((u) => u.status)).toEqual(["running", "error"]);
    expect(bridge.sendToolCancelled).toHaveBeenCalledWith({
      reason: "transport lost",
    });
  });
});
