import { describe, expect, it } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import {
  buildMrtrChatResumeBody,
  findUnresolvedMrtrToolCallId,
} from "../mrtr-chat-resume";

function assistant(parts: unknown[]): UIMessage {
  return { id: "m", role: "assistant", parts } as unknown as UIMessage;
}

describe("findUnresolvedMrtrToolCallId", () => {
  it("finds the open tool call a suspended round belongs to", () => {
    const messages = [
      assistant([
        {
          type: "tool-create_issue",
          toolCallId: "call-1",
          state: "input-available",
        },
      ]),
    ];
    expect(findUnresolvedMrtrToolCallId(messages, "create_issue")).toBe(
      "call-1"
    );
  });

  it("skips calls that already have output", () => {
    // A resolved call is not the slot the driven result belongs in.
    const messages = [
      assistant([
        {
          type: "tool-create_issue",
          toolCallId: "call-done",
          state: "output-available",
        },
        {
          type: "tool-create_issue",
          toolCallId: "call-open",
          state: "input-available",
        },
      ]),
    ];
    expect(findUnresolvedMrtrToolCallId(messages, "create_issue")).toBe(
      "call-open"
    );
  });

  it("prefers the call whose tool name matches the round's operation", () => {
    // A multi-call step can leave several slots open; only the matching one
    // belongs to this continuation.
    const messages = [
      assistant([
        {
          type: "tool-create_issue",
          toolCallId: "call-a",
          state: "input-available",
        },
        { type: "tool-search", toolCallId: "call-b", state: "input-available" },
      ]),
    ];
    expect(findUnresolvedMrtrToolCallId(messages, "create_issue")).toBe(
      "call-a"
    );
  });

  it("falls back to the newest open call when no name matches", () => {
    const messages = [
      assistant([
        { type: "tool-search", toolCallId: "call-a", state: "input-available" },
        {
          type: "dynamic-tool",
          toolName: "other",
          toolCallId: "call-b",
          state: "input-available",
        },
      ]),
    ];
    expect(findUnresolvedMrtrToolCallId(messages, "create_issue")).toBe(
      "call-b"
    );
  });

  it("returns undefined when the transcript has no open tool call", () => {
    // The caller must then withdraw rather than resume into nothing.
    const messages = [
      assistant([{ type: "text", text: "hi" }]),
      assistant([
        { type: "tool-x", toolCallId: "call-1", state: "output-error" },
      ]),
    ];
    expect(findUnresolvedMrtrToolCallId(messages)).toBeUndefined();
    expect(findUnresolvedMrtrToolCallId([])).toBeUndefined();
  });

  it("ignores user messages", () => {
    const messages = [
      {
        id: "u",
        role: "user",
        parts: [
          { type: "tool-x", toolCallId: "call-1", state: "input-available" },
        ],
      } as unknown as UIMessage,
    ];
    expect(findUnresolvedMrtrToolCallId(messages)).toBeUndefined();
  });
});

describe("buildMrtrChatResumeBody", () => {
  it("names the tool-call slot the driven result fills", () => {
    expect(
      buildMrtrChatResumeBody({
        toolCallId: "call-1",
        serverId: "srv-1",
        continuationId: "cont-1",
        round: 2,
        responses: { branch: { action: "decline" } },
      })
    ).toEqual({
      mrtrResume: {
        toolCallId: "call-1",
        serverId: "srv-1",
        continuationId: "cont-1",
        round: 2,
        responses: { branch: { action: "decline" } },
      },
    });
  });
});
