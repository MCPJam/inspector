import { render } from "@testing-library/react";
import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";

import {
  formatMessageTime,
  getMessageTimestampMs,
  hydrateMessageTimestamps,
  timestampMessageById,
  withMessageTimestampMetadata,
} from "../message-timestamp";
import { ReadOnlyTranscript } from "../read-only-transcript";
import { assistantParts, userText } from "./factories";

describe("message timestamps", () => {
  it("merges a timestamp without dropping existing metadata", () => {
    expect(
      withMessageTimestampMetadata(
        { senderUserId: "user-1", totalTokens: 12 },
        1_000
      )
    ).toEqual({
      senderUserId: "user-1",
      totalTokens: 12,
      timestampMs: 1_000,
    });
  });

  it("preserves an existing timestamp", () => {
    const metadata = { timestampMs: 500, totalTokens: 12 };
    expect(withMessageTimestampMetadata(metadata, 1_000)).toBe(metadata);
  });

  it("formats timestamps with the browser's local hour and minute", () => {
    const timestampMs = 1_700_000_000_000;
    expect(formatMessageTime(timestampMs)).toBe(
      new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(timestampMs))
    );
  });

  it("timestamps only the requested message", () => {
    const messages = [userText("one", "u1"), userText("two", "u2")];
    const timestamped = timestampMessageById(messages, "u2", 2_000);

    expect(getMessageTimestampMs(timestamped[0]!)).toBeUndefined();
    expect(getMessageTimestampMs(timestamped[1]!)).toBe(2_000);
  });

  it("hydrates user and assistant messages from persisted turn timing", () => {
    const messages = [
      userText("one", "u1"),
      assistantParts([{ type: "text", text: "first" }], "a1"),
      userText("internal", "model-context-1"),
      assistantParts([{ type: "text", text: "first follow-up" }], "a2"),
      userText("two", "u2"),
      assistantParts([{ type: "text", text: "second" }], "a3"),
    ];

    const hydrated = hydrateMessageTimestamps(messages, [
      { promptIndex: 0, startedAt: 100, endedAt: 200 },
      { promptIndex: 1, startedAt: 300, endedAt: 400 },
    ]);

    expect(hydrated.map(getMessageTimestampMs)).toEqual([
      100,
      200,
      undefined,
      200,
      300,
      400,
    ]);
  });

  it("keeps reliable message metadata and leaves missing turns unstamped", () => {
    const existing = {
      ...userText("one", "u1"),
      metadata: { timestampMs: 50, senderUserId: "user-1" },
    } as UIMessage;
    const missing = userText("two", "u2");

    const hydrated = hydrateMessageTimestamps(
      [existing, missing],
      [{ promptIndex: 0, startedAt: 100, endedAt: 200 }]
    );

    expect(hydrated[0]).toBe(existing);
    expect(getMessageTimestampMs(hydrated[1]!)).toBeUndefined();
  });

  it("renders times for user, assistant, and tool-only assistant messages", () => {
    const messages = [
      {
        ...userText("hello", "u1"),
        metadata: { timestampMs: 1_700_000_000_000 },
      },
      {
        ...assistantParts([{ type: "text", text: "hi" }], "a1"),
        metadata: { timestampMs: 1_700_000_001_000 },
      },
      {
        ...assistantParts(
          [
            {
              type: "tool-example",
              toolCallId: "call-1",
              state: "output-available",
              input: {},
              output: {},
            },
          ],
          "a2"
        ),
        metadata: { timestampMs: 1_700_000_002_000 },
      },
    ] as UIMessage[];

    const { container } = render(<ReadOnlyTranscript messages={messages} />);
    const times = container.querySelectorAll("time");
    expect(times).toHaveLength(3);
    for (const time of times) {
      expect(time.textContent).not.toBe("");
      expect(time).toHaveAttribute("dateTime");
      expect(time.parentElement).toHaveClass("opacity-0");
    }
    expect(container.getElementsByClassName("group/user-message")).toHaveLength(
      1
    );
    expect(
      container.getElementsByClassName("group/assistant-message")
    ).toHaveLength(2);
  });
});
