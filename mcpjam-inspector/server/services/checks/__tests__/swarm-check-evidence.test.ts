import { describe, expect, it } from "vitest";
import { swarmCheckInventory } from "../swarm-check-evidence";
import { extractTranscriptEvidence } from "../../evals/transcript-evidence";
import { extractToolCallsFromEnvelopeMessages } from "../chat-session-envelope";
import {
  buildIterationTranscript,
  evaluatePredicates,
} from "@/shared/eval-matching";
const server = (id = "server") => ({
  serverId: id,
  tools: [
    {
      name: "search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      annotations: {},
    },
  ],
});
const envelope = (servers = [server()]) => ({
  recordedContext: { toolSnapshots: [{ snapshot: { version: 3, servers } }] },
});
describe("swarm checks use archived eval evidence", () => {
  it("refuses absent, partial, changed, or ambiguous declarations", () => {
    expect(swarmCheckInventory({})).toBeUndefined();
    expect(
      swarmCheckInventory(
        envelope([{ ...server(), captureError: "lost" } as never]),
      ),
    ).toBeUndefined();
    expect(
      swarmCheckInventory(envelope([server("a"), server("b")])),
    ).toBeUndefined();
  });
  it("preserves repeated calls and applies the shared schema evaluator", () => {
    const messages = ["one", "two"].map((toolCallId) => ({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolName: "search",
          toolCallId,
          input: { query: 123 },
        },
      ],
    }));
    const calls = extractToolCallsFromEnvelopeMessages(messages);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.toolCallId)).toEqual(["one", "two"]);
    const transcript = buildIterationTranscript({
      trace: { messages },
      toolCalls: calls,
      toolInventory: swarmCheckInventory(envelope()),
      ...extractTranscriptEvidence({ messages }),
    });
    const [result] = evaluatePredicates(transcript, [
      { type: "argumentsMatchToolSchema", role: "advisory", severity: "warn" },
    ]);
    expect(result).toMatchObject({ passed: false });
    expect(result.status).not.toBe("error");
  });
});
