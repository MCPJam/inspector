/**
 * The order `@ai-sdk/harness-acp` 1.0.60 delivers a Cursor MCP call that
 * needs permission, and what Cursor CLI approvals rely on in it.
 *
 * Read from the installed 1.0.60 bridge: tool-call updates are held up to
 * 1 s (`CORRELATION_WINDOW_MS`) for host-tool matching, the raw ACP update is
 * emitted at once, and a permission request forces the call out immediately
 * with only the request's own fields, so `input` is `"{}"`. Cursor itself (probe
 * D5) sends `tool_call` pending, then the `rawInput` update, then
 * `in_progress`, then `session/request_permission`, then the MCP request.
 */
import { describe, expect, it, vi } from "vitest";
import type { HarnessV1, HarnessV1StreamPart } from "@ai-sdk/harness";
import { withAcpPermissionCallInput } from "../acp-permission-input";

const CALL = "tool_1a6267b0-6e38-4177-8159-3c60093864e";
const RAW_INPUT = {
  providerIdentifier: "probe",
  toolName: "probe_echo",
  args: { text: "alpha" },
};

/** One turn of a runtime that emits `parts`, wrapped as the Cursor adapter wraps it. */
async function emitted(parts: HarnessV1StreamPart[]) {
  const runtime = {
    doStart: async () => ({
      doPromptTurn: async ({ emit }: { emit: (part: HarnessV1StreamPart) => void }) => {
        for (const part of parts) emit(part);
        return { done: Promise.resolve() };
      },
    }),
  } as unknown as HarnessV1;
  const seen: HarnessV1StreamPart[] = [];
  const session = await withAcpPermissionCallInput(runtime).doStart({} as never);
  await session.doPromptTurn({ emit: (part: HarnessV1StreamPart) => seen.push(part) } as never);
  return seen;
}

const raw = (update: Record<string, unknown>) =>
  ({ type: "raw", rawValue: { toolCallId: CALL, ...update } }) as HarnessV1StreamPart;
const call = (input: string) =>
  ({
    type: "tool-call",
    toolCallId: CALL,
    toolName: `acp_tool_${CALL}`,
    input,
    providerExecuted: true,
  }) as HarnessV1StreamPart;
const approval = {
  type: "tool-approval-request",
  approvalId: "acp-permission-1",
  toolCallId: CALL,
} as HarnessV1StreamPart;

describe("a Cursor MCP call that asks permission, as acp 1.0.60 delivers it", () => {
  it("names its server, tool and arguments by the time its approval request arrives", async () => {
    const seen = await emitted([
      raw({ sessionUpdate: "tool_call", status: "pending", rawInput: {} }),
      raw({ sessionUpdate: "tool_call_update", title: "probe: probe_echo", rawInput: RAW_INPUT }),
      raw({ sessionUpdate: "tool_call_update", status: "in_progress" }),
      call("{}"),
      approval,
    ]);
    const types = seen.map((part) => part.type);
    // The call still precedes its approval request.
    expect(types.indexOf("tool-call")).toBeLessThan(types.indexOf("tool-approval-request"));
    const restored = seen.find((part) => part.type === "tool-call");
    expect(JSON.parse((restored as { input: string }).input)).toEqual(RAW_INPUT);
    // Nothing else is touched: the raw updates still reach the runner.
    expect(types).toEqual(["raw", "raw", "raw", "tool-call", "tool-approval-request"]);
  });

  it("leaves a call that already carries its input alone", async () => {
    const input = JSON.stringify({ ...RAW_INPUT, args: { text: "beta" } });
    const seen = await emitted([
      raw({ sessionUpdate: "tool_call_update", rawInput: RAW_INPUT }),
      call(input),
    ]);
    expect((seen[1] as { input: string }).input).toBe(input);
  });

  it("cannot invent an input no update carried, so that approval stays unbound", async () => {
    const seen = await emitted([
      raw({ sessionUpdate: "tool_call", status: "pending", rawInput: {} }),
      { type: "raw", rawValue: { type: "mcpjam:elicitation", phase: "cancel" } } as HarnessV1StreamPart,
      call("{}"),
      approval,
    ]);
    expect((seen[2] as { input: string }).input).toBe("{}");
  });

  it("keeps each turn's calls to that turn", async () => {
    const parts = vi.fn();
    const runtime = {
      doStart: async () => ({
        doPromptTurn: async ({ emit }: { emit: (part: HarnessV1StreamPart) => void }) => {
          emit(raw({ sessionUpdate: "tool_call_update", rawInput: RAW_INPUT }));
          return { done: Promise.resolve() };
        },
        doContinueTurn: async ({ emit }: { emit: (part: HarnessV1StreamPart) => void }) => {
          emit(call("{}"));
          return { done: Promise.resolve() };
        },
      }),
    } as unknown as HarnessV1;
    const session = await withAcpPermissionCallInput(runtime).doStart({} as never);
    await session.doPromptTurn({ emit: parts } as never);
    await session.doContinueTurn({ emit: parts } as never);
    expect(parts.mock.calls.at(-1)?.[0]).toMatchObject({ input: "{}" });
  });
});
