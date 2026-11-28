import { describe, expect, it } from "vitest";
import type { UIMessageChunk } from "ai";
import { buildDirectChatTraceCallbacks } from "../direct-chat-sse-callbacks.js";

function turnStartFrom(eventAtTurn?: Parameters<typeof buildDirectChatTraceCallbacks>[1]) {
  const chunks: UIMessageChunk[] = [];
  buildDirectChatTraceCallbacks({ write: (chunk) => chunks.push(chunk) }, eventAtTurn).onTurnStart?.({
    turnId: "turn-1",
    promptIndex: 2,
    startedAtMs: 1000,
  } as never);
  return (chunks[0] as unknown as { data: Record<string, unknown> }).data;
}

describe("buildDirectChatTraceCallbacks turn_start", () => {
  it("carries the event that started the turn", () => {
    const event = {
      name: "comment.created",
      receivedAt: 900,
      origin: "simulation" as const,
      delivery: "poll" as const,
    };
    expect(turnStartFrom(event)).toEqual({
      type: "turn_start",
      turnId: "turn-1",
      promptIndex: 2,
      startedAtMs: 1000,
      event,
    });
  });

  it("names no event on a turn no event started", () => {
    expect(turnStartFrom()).not.toHaveProperty("event");
  });
});
