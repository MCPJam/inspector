import { describe, expect, it } from "vitest";
import {
  emitPinnedTurnSse,
  type PinnedTurnSseDeps,
  type PinnedTurnSsePayload,
} from "../pinned-turn-sse";
import type { EvalStreamEvent } from "@/shared/eval-stream-events";

function makeDeps() {
  const events: EvalStreamEvent[] = [];
  const deps: PinnedTurnSseDeps = {
    emit: (event) => events.push(event),
    withSystemPrefix: (msgs) => msgs,
    buildTraceSnapshotEvent: ({ turnIndex, snapshotKind, actualToolCalls }) =>
      ({
        type: "trace_snapshot",
        turnIndex,
        snapshotKind,
        actualToolCalls,
      }) as unknown as EvalStreamEvent,
  };
  return { events, deps };
}

const basePayload: PinnedTurnSsePayload = {
  turnIndex: 2,
  prompt: 'Pinned tool call: show_map on "Weather"',
  messages: [{ role: "user", content: "hi" }],
  spans: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
};

describe("emitPinnedTurnSse", () => {
  it("emits the full success sequence with tool events", () => {
    const { events, deps } = makeDeps();
    emitPinnedTurnSse(deps, {
      ...basePayload,
      toolCall: { toolName: "show_map", arguments: { city: "SF" } },
      toolCallId: "pinned-2-1",
      toolResult: { content: [] },
    });
    expect(events.map((e) => (e as { type: string }).type)).toEqual([
      "turn_start",
      "step_status",
      "tool_call",
      "tool_result",
      "trace_snapshot",
      "turn_finish",
      "step_status",
    ]);
    expect(events[0]).toMatchObject({
      turnIndex: 2,
      prompt: basePayload.prompt,
    });
    expect(events[1]).toMatchObject({ kind: "toolCall", status: "running" });
    expect(events[2]).toMatchObject({
      toolName: "show_map",
      toolCallId: "pinned-2-1",
      args: { city: "SF" },
    });
    expect(events[3]).toMatchObject({ toolCallId: "pinned-2-1" });
    expect(events[3]).not.toHaveProperty("isError");
    expect(events[4]).toMatchObject({ snapshotKind: "turn_finish" });
    expect(events[6]).toMatchObject({ kind: "toolCall", status: "ok" });
  });

  it("emits failure snapshot + error for a tool error", () => {
    const { events, deps } = makeDeps();
    emitPinnedTurnSse(deps, {
      ...basePayload,
      toolCall: { toolName: "show_map", arguments: {} },
      toolCallId: "pinned-2-1",
      toolResult: { error: "boom", kind: "content-error" },
      toolResultIsError: true,
      toolError: {
        toolName: "show_map",
        kind: "content-error",
        message: "boom",
      },
    });
    expect(events.map((e) => (e as { type: string }).type)).toEqual([
      "turn_start",
      "step_status",
      "tool_call",
      "tool_result",
      "trace_snapshot",
      "turn_finish",
      "step_status",
      "error",
    ]);
    expect(events[3]).toMatchObject({ isError: true });
    expect(events[4]).toMatchObject({ snapshotKind: "failure" });
    expect(events[6]).toMatchObject({ status: "fail", detail: "boom" });
    expect(events[7]).toMatchObject({ message: "boom" });
  });

  it("omits tool events entirely for a not-connected setup failure", () => {
    const { events, deps } = makeDeps();
    emitPinnedTurnSse(deps, {
      ...basePayload,
      iterationError: 'pinned_server_not_connected: "Weather" is not connected',
    });
    expect(events.map((e) => (e as { type: string }).type)).toEqual([
      "turn_start",
      "step_status",
      "trace_snapshot",
      "turn_finish",
      "step_status",
      "error",
    ]);
    expect(events[2]).toMatchObject({
      snapshotKind: "failure",
      actualToolCalls: [],
    });
    expect(events[4]).toMatchObject({ status: "fail" });
  });
});
