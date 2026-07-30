import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActivePlaygroundConversation,
  decideConversationUrlSync,
  isConversationRestoreOutstanding,
  PLAYGROUND_CONVERSATION_PARAM,
  readActivePlaygroundConversation,
  readConversationParam,
  writeActivePlaygroundConversation,
} from "../playground-conversation-url";

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

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

describe("active playground conversation storage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips an entry within the same project", () => {
    writeActivePlaygroundConversation({
      chatSessionId: "chat-1",
      projectId: "proj-1",
      updatedAt: NOW,
    });

    expect(readActivePlaygroundConversation("proj-1", NOW)).toBe("chat-1");
  });

  it("round-trips an entry in local mode (no project)", () => {
    writeActivePlaygroundConversation({
      chatSessionId: "chat-1",
      projectId: null,
      updatedAt: NOW,
    });

    expect(readActivePlaygroundConversation(null, NOW)).toBe("chat-1");
    expect(readActivePlaygroundConversation(undefined, NOW)).toBe("chat-1");
  });

  it("never restores a conversation from a different project", () => {
    writeActivePlaygroundConversation({
      chatSessionId: "chat-1",
      projectId: "proj-1",
      updatedAt: NOW,
    });

    expect(readActivePlaygroundConversation("proj-2", NOW)).toBeNull();
    expect(readActivePlaygroundConversation(null, NOW)).toBeNull();
    // A mismatch must not delete the entry — switching back still finds it.
    expect(readActivePlaygroundConversation("proj-1", NOW)).toBe("chat-1");
  });

  it("ignores stale entries", () => {
    writeActivePlaygroundConversation({
      chatSessionId: "chat-1",
      projectId: "proj-1",
      updatedAt: NOW,
    });

    expect(readActivePlaygroundConversation("proj-1", NOW + 6 * DAY_MS)).toBe(
      "chat-1",
    );
    expect(
      readActivePlaygroundConversation("proj-1", NOW + 8 * DAY_MS),
    ).toBeNull();
  });

  it("returns null for missing, malformed, or incomplete entries", () => {
    expect(readActivePlaygroundConversation("proj-1", NOW)).toBeNull();

    localStorage.setItem("mcpjam:playground-active-conversation:v1", "{oops");
    expect(readActivePlaygroundConversation("proj-1", NOW)).toBeNull();

    localStorage.setItem("mcpjam:playground-active-conversation:v1", "null");
    expect(readActivePlaygroundConversation("proj-1", NOW)).toBeNull();

    localStorage.setItem(
      "mcpjam:playground-active-conversation:v1",
      JSON.stringify({ chatSessionId: "  ", projectId: "proj-1", updatedAt: NOW }),
    );
    expect(readActivePlaygroundConversation("proj-1", NOW)).toBeNull();

    localStorage.setItem(
      "mcpjam:playground-active-conversation:v1",
      JSON.stringify({ chatSessionId: "chat-1", projectId: "proj-1" }),
    );
    expect(readActivePlaygroundConversation("proj-1", NOW)).toBeNull();
  });

  it("does not write a blank conversation id", () => {
    writeActivePlaygroundConversation({
      chatSessionId: "   ",
      projectId: "proj-1",
      updatedAt: NOW,
    });

    expect(localStorage.length).toBe(0);
  });

  it("clears the entry", () => {
    writeActivePlaygroundConversation({
      chatSessionId: "chat-1",
      projectId: "proj-1",
      updatedAt: NOW,
    });

    clearActivePlaygroundConversation();

    expect(readActivePlaygroundConversation("proj-1", NOW)).toBeNull();
  });

  it("survives storage that throws", () => {
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    expect(() =>
      writeActivePlaygroundConversation({
        chatSessionId: "chat-1",
        projectId: null,
        updatedAt: NOW,
      }),
    ).not.toThrow();
    setItem.mockRestore();

    const getItem = vi
      .spyOn(window.localStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(readActivePlaygroundConversation(null, NOW)).toBeNull();
    getItem.mockRestore();

    const removeItem = vi
      .spyOn(window.localStorage, "removeItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(() => clearActivePlaygroundConversation()).not.toThrow();
    removeItem.mockRestore();
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
