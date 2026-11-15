import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  forwardingApprovalId,
  readForwardingApprovalId,
  stripForwardingRequestBody,
  withoutForwardingGateParts,
} from "../forwarding-approval";

describe("forwarding approval presentation", () => {
  const messages: UIMessage[] = [
    {
      id: "reply",
      role: "assistant",
      parts: [
        { type: "text", text: "Calling a tool" },
        {
          type: "dynamic-tool",
          toolName: "Approve write",
          toolCallId: "mcpjam-forwarding:execution",
          state: "input-available",
          input: {},
        },
        {
          type: "dynamic-tool",
          toolName: "mcp__server__write",
          toolCallId: "native-call",
          state: "output-available",
          input: {},
          output: { ok: true },
        },
      ],
    },
  ];
  it("keeps native tool evidence and removes only gate cards from model history", () => {
    expect(withoutForwardingGateParts(messages)[0].parts).toEqual([
      messages[0].parts[0],
      messages[0].parts[2],
    ]);
    expect(messages[0].parts).toHaveLength(3);
    const body = JSON.stringify({ messages, model: { id: "same-model" } });
    const filtered = JSON.parse(stripForwardingRequestBody(body));
    expect(filtered.model).toEqual({ id: "same-model" });
    expect(filtered.messages[0].parts).toHaveLength(2);
  });
  it("does not rewrite ordinary requests or fail on malformed bodies", () => {
    const ordinary = '{ "messages": [], "other": true }';
    expect(stripForwardingRequestBody(ordinary)).toBe(ordinary);
    expect(stripForwardingRequestBody("{")).toBe("{");
  });
  it("round-trips selectors separately from the signed approval", () => {
    const owner = {
      kind: "chat",
      userId: "user",
      serverId: "server",
      harnessSessionId: "session",
    };
    const id = forwardingApprovalId("execution", owner, "signed-token");
    expect(readForwardingApprovalId(id)).toEqual({
      executionId: "execution",
      owner,
      approvalId: "signed-token",
    });
    expect(readForwardingApprovalId("mjfg1:{")).toBeNull();
    expect(readForwardingApprovalId("native-approval")).toBeNull();
  });
});
