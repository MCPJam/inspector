import { describe, expect, it } from "vitest";
import {
  decideConversationUrlSync,
  isConversationRestoreOutstanding,
  PLAYGROUND_CONVERSATION_PARAM,
  readConversationParam,
} from "../playground-conversation-url";

describe("readConversationParam", () => {
  it("reads the conversation id", () => {
    expect(readConversationParam("?conversation=abc123")).toBe("abc123");
    expect(readConversationParam("conversation=abc123")).toBe("abc123");
  });

  it("treats absent, blank, and whitespace-only values as no conversation", () => {
    expect(readConversationParam("")).toBeNull();
    expect(readConversationParam("?other=1")).toBeNull();
    expect(readConversationParam("?conversation=")).toBeNull();
    expect(readConversationParam("?conversation=%20%20")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(readConversationParam("?conversation=%20abc%20")).toBe("abc");
  });

  it("ignores other params", () => {
    expect(
      readConversationParam(`?tab=x&${PLAYGROUND_CONVERSATION_PARAM}=abc&y=2`),
    ).toBe("abc");
  });
});

describe("decideConversationUrlSync", () => {
  it("does nothing while a restore is still owed", () => {
    // The restore effect reads the param; stripping it here on the empty
    // transcript that precedes hydration would cancel the restore.
    expect(
      decideConversationUrlSync({
        paramValue: "chat-1",
        chatSessionId: "fresh",
        hasMessages: false,
        restorePending: true,
      }),
    ).toEqual({ kind: "noop" });
  });

  it("writes the active session once the transcript has messages", () => {
    expect(
      decideConversationUrlSync({
        paramValue: null,
        chatSessionId: "chat-1",
        hasMessages: true,
        restorePending: false,
      }),
    ).toEqual({ kind: "set", conversationId: "chat-1" });
  });

  it("rewrites the param when the session forks or another thread loads", () => {
    expect(
      decideConversationUrlSync({
        paramValue: "chat-1",
        chatSessionId: "chat-2",
        hasMessages: true,
        restorePending: false,
      }),
    ).toEqual({ kind: "set", conversationId: "chat-2" });
  });

  it("leaves an already-correct param alone", () => {
    expect(
      decideConversationUrlSync({
        paramValue: "chat-1",
        chatSessionId: "chat-1",
        hasMessages: true,
        restorePending: false,
      }),
    ).toEqual({ kind: "noop" });
  });

  it("never clears from an empty transcript alone", () => {
    // Reset and the chat hook's auth-bootstrap re-mint are indistinguishable
    // here; clearing on the second one would lose the conversation. Clearing
    // is driven by the explicit reset signal instead.
    expect(
      decideConversationUrlSync({
        paramValue: "chat-1",
        chatSessionId: "chat-2",
        hasMessages: false,
        restorePending: false,
      }),
    ).toEqual({ kind: "noop" });
  });

  it("does not churn the URL on an empty chat with no param", () => {
    expect(
      decideConversationUrlSync({
        paramValue: null,
        chatSessionId: "chat-1",
        hasMessages: false,
        restorePending: false,
      }),
    ).toEqual({ kind: "noop" });
  });
});

describe("isConversationRestoreOutstanding", () => {
  it("is outstanding on a cold load carrying a param", () => {
    expect(
      isConversationRestoreOutstanding({
        paramValue: "chat-1",
        chatSessionId: "freshly-minted",
        hasMessages: false,
        hasFailed: false,
      }),
    ).toBe(true);
  });

  it("re-arms after the chat hook re-mints its session id", () => {
    // auth-bootstrap wipes the transcript and mints a new id under the newly
    // resolved scope. The param must survive that so the restore can re-run.
    expect(
      isConversationRestoreOutstanding({
        paramValue: "chat-1",
        chatSessionId: "re-minted",
        hasMessages: false,
        hasFailed: false,
      }),
    ).toBe(true);
  });

  it("is settled once the restored session is the active one", () => {
    expect(
      isConversationRestoreOutstanding({
        paramValue: "chat-1",
        chatSessionId: "chat-1",
        hasMessages: true,
        hasFailed: false,
      }),
    ).toBe(false);
  });

  it("is settled when the transcript already has content", () => {
    // A detach/fork mints a new id on a populated transcript — that is a new
    // conversation to record, not a restore to wait for.
    expect(
      isConversationRestoreOutstanding({
        paramValue: "chat-1",
        chatSessionId: "chat-2",
        hasMessages: true,
        hasFailed: false,
      }),
    ).toBe(false);
  });

  it("is settled with no param", () => {
    expect(
      isConversationRestoreOutstanding({
        paramValue: null,
        chatSessionId: "chat-1",
        hasMessages: false,
        hasFailed: false,
      }),
    ).toBe(false);
  });

  it("stops being outstanding once the id has definitively failed", () => {
    expect(
      isConversationRestoreOutstanding({
        paramValue: "chat-1",
        chatSessionId: "chat-2",
        hasMessages: false,
        hasFailed: true,
      }),
    ).toBe(false);
  });
});
