/**
 * The spans a web turn persists, and what each one lets a reader trust.
 */
import { describe, expect, it } from "vitest";
import { webTurnSpans, type WebToolCall } from "../web-client-trace";

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

describe("webTurnSpans", () => {
  it("calls a call with no recorded outcome incomplete evidence, and a settled one complete", () => {
    const spans = webTurnSpans({
      calls: [call("forwarded", "open"), call("result", "done")],
      startedAt: Date.parse("2026-11-20T08:00:00.000Z"),
      endedAt: Date.parse("2026-11-20T08:00:05.000Z"),
      promptIndex: 0,
      modelId: "anthropic/claude-sonnet-4.5",
    });
    const tools = spans.filter((span) => span.category === "tool");
    // Both crossed the endpoint; only the settled one has an outcome behind it.
    expect(tools.map((span) => [span.evidenceRequestId, span.wireCorroborated, span.evidenceStatus])).toEqual([
      ["open", true, "incomplete"],
      ["done", true, "complete"],
    ]);
  });
});
