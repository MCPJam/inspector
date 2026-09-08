import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import {
  clearScenarioChatTranscript,
  readScenarioChatTranscript,
  scenarioChatTranscriptStorageKey,
  writeScenarioChatTranscript,
} from "../scenario-chat-transcript";

const SCENARIO_ID = "scn_1";
const KEY = scenarioChatTranscriptStorageKey(SCENARIO_ID);

function message(id: string, text: string): UIMessage {
  return {
    id,
    role: id.startsWith("user") ? "user" : "assistant",
    parts: [{ type: "text", text }],
  } as unknown as UIMessage;
}

describe("scenario chat transcript storage", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips the transcript and its chat session id", () => {
    const messages = [message("user-1", "hello"), message("assistant-1", "hi")];
    writeScenarioChatTranscript(SCENARIO_ID, {
      chatSessionId: "chat-1",
      messages,
    });

    expect(readScenarioChatTranscript(SCENARIO_ID)).toEqual({
      chatSessionId: "chat-1",
      messages,
    });
  });

  it("is scoped per scenario", () => {
    writeScenarioChatTranscript(SCENARIO_ID, {
      chatSessionId: "chat-1",
      messages: [message("user-1", "hello")],
    });

    expect(readScenarioChatTranscript("scn_other")).toBeNull();
  });

  it("clears the row when the transcript is empty", () => {
    writeScenarioChatTranscript(SCENARIO_ID, {
      chatSessionId: "chat-1",
      messages: [message("user-1", "hello")],
    });

    writeScenarioChatTranscript(SCENARIO_ID, {
      chatSessionId: "chat-1",
      messages: [],
    });

    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(readScenarioChatTranscript(SCENARIO_ID)).toBeNull();
  });

  it("removes a row it cannot use instead of failing on it every mount", () => {
    sessionStorage.setItem(KEY, "{not json");
    expect(readScenarioChatTranscript(SCENARIO_ID)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();

    // Shape it can parse but not resume from: no chat session id means the next
    // turn has no thread to append to.
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ messages: [message("user-1", "hello")] })
    );
    expect(readScenarioChatTranscript(SCENARIO_ID)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("drops the oldest turns rather than the whole resume when oversized", () => {
    // One early turn carrying an attachment-sized payload, then small ones.
    const messages = [
      message("user-1", "x".repeat(1_200_000)),
      message("assistant-1", "small reply"),
      message("user-2", "still here?"),
    ];

    writeScenarioChatTranscript(SCENARIO_ID, {
      chatSessionId: "chat-1",
      messages,
    });

    const restored = readScenarioChatTranscript(SCENARIO_ID);
    expect(restored?.chatSessionId).toBe("chat-1");
    expect(restored?.messages.map((m) => m.id)).toEqual([
      "assistant-1",
      "user-2",
    ]);
  });

  it("clears rather than keep a stale row when even the newest turn is too big", () => {
    writeScenarioChatTranscript(SCENARIO_ID, {
      chatSessionId: "chat-1",
      messages: [message("user-1", "hello")],
    });

    writeScenarioChatTranscript(SCENARIO_ID, {
      chatSessionId: "chat-1",
      messages: [message("user-2", "y".repeat(1_200_000))],
    });

    // A transcript missing its most recent turns while looking complete is
    // worse than none: the tester cannot tell anything is absent.
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("clears when the write is rejected by the quota", () => {
    writeScenarioChatTranscript(SCENARIO_ID, {
      chatSessionId: "chat-1",
      messages: [message("user-1", "hello")],
    });

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    writeScenarioChatTranscript(SCENARIO_ID, {
      chatSessionId: "chat-1",
      messages: [message("user-2", "next")],
    });

    vi.restoreAllMocks();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("clear() removes the row", () => {
    writeScenarioChatTranscript(SCENARIO_ID, {
      chatSessionId: "chat-1",
      messages: [message("user-1", "hello")],
    });

    clearScenarioChatTranscript(SCENARIO_ID);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});
