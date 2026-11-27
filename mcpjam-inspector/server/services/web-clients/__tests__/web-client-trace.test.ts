/**
 * The spans a web turn persists, and what each one lets a reader trust.
 */
import { describe, expect, it } from "vitest";
import { matchWebToolCalls, webTurnMessages, webTurnSpans, type WebToolCall } from "../web-client-trace";

const call = (state: WebToolCall["state"], ledgerEntryId: string): WebToolCall => ({
  toolName: "echo",
  match: "tool-use-id",
  toolUseId: `toolu_${ledgerEntryId}`,
  ledgerEntryId,
  serverId: "orders",
  state,
  forwardedAt: "2026-11-20T08:00:01.000Z",
  ...(state === "forwarded" ? {} : { settledAt: "2026-11-20T08:00:02.000Z" }),
});

const turn = (calls: WebToolCall[], over: { turnId?: string; failed?: boolean } = {}) =>
  webTurnSpans({
    calls,
    turnId: over.turnId ?? "turn-1",
    startedAt: Date.parse("2026-11-20T08:00:00.000Z"),
    endedAt: Date.parse("2026-11-20T08:00:05.000Z"),
    promptIndex: 0,
    modelId: "anthropic/claude-sonnet-4.5",
    ...(over.failed ? { failed: true } : {}),
  });

const narrated: WebToolCall = { toolName: "echo", match: "narration-only" };
const saved = { conversationId: "c-1", url: "https://vendor.example/c/c-1", replyText: "done", toolCalls: [] };

describe("webTurnSpans", () => {
  it("calls the whole turn's evidence incomplete while any call has no recorded outcome", () => {
    const tools = turn([call("forwarded", "open"), call("result", "done"), narrated]).filter(
      (span) => span.category === "tool",
    );
    // A call the wire never showed may not have been seen yet, so the
    // narration-only one is no claim that it never happened.
    expect(tools.map((span) => [span.evidenceRequestId, span.wireCorroborated, span.evidenceStatus])).toEqual([
      ["open", true, "incomplete"],
      ["done", true, "incomplete"],
      [undefined, false, "incomplete"],
    ]);
  });

  it("calls a settled turn's evidence complete, narration-only calls included", () => {
    const tools = turn([call("result", "done"), narrated]).filter((span) => span.category === "tool");
    expect(tools.map((span) => [span.wireCorroborated, span.evidenceStatus])).toEqual([
      [true, "complete"],
      [false, "complete"],
    ]);
  });

  it("names a call with no id of its own within its turn, in the spans and the transcript", () => {
    const ids = (turnId: string) => [
      turn([narrated], { turnId }).find((span) => span.category === "tool")?.toolCallId,
      (webTurnMessages(saved, [narrated], turnId)[0]!.content as Array<{ toolCallId?: string }>)[0]!.toolCallId,
    ];
    expect(ids("turn-1")).toEqual(["web-call-turn-1-0", "web-call-turn-1-0"]);
    expect(ids("turn-2")).toEqual(["web-call-turn-2-0", "web-call-turn-2-0"]);
  });

  it("puts a stopped turn's calls on an errored step", () => {
    const spans = turn([call("result", "done")], { failed: true });
    expect(spans.map((span) => [span.category, span.status])).toEqual([
      ["step", "error"],
      ["tool", "ok"],
    ]);
  });
});

describe("matchWebToolCalls", () => {
  it("gives a refused call that carries no id the id its refusal was recorded under", () => {
    const calls = matchWebToolCalls({
      wire: [],
      conversation: [{ toolName: "echo" }, { toolName: "echo" }, { toolName: "list", toolUseId: "toolu_1" }],
      serverOfConnector: () => undefined,
      blocked: [
        { toolName: "echo", toolCallId: "web-blocked-1" },
        { toolName: "list", toolCallId: "toolu_1" },
      ],
    });
    // One refusal names one call; a call with the vendor's own id keeps it.
    expect(calls.map((found) => [found.toolName, found.policyBlockId, found.toolUseId])).toEqual([
      ["echo", "web-blocked-1", undefined],
      ["echo", undefined, undefined],
      ["list", undefined, "toolu_1"],
    ]);
    const ids = (webTurnMessages(saved, calls, "turn-1")[0]!.content as Array<{ toolCallId?: string }>)
      .map((part) => part.toolCallId)
      .slice(0, 3);
    expect(ids).toEqual(["web-blocked-1", "web-call-turn-1-1", "toolu_1"]);
  });
});
