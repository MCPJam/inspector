import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PENDING_AGENT_PROMPT_KEY_PREFIX,
  clearPendingAgentPrompt,
  pendingAgentPromptKey,
  writePendingAgentPrompt,
} from "../pending-prompt";

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("pendingAgentPromptKey", () => {
  it("namespaces the session id under the shared prefix", () => {
    expect(pendingAgentPromptKey("abc")).toBe(
      `${PENDING_AGENT_PROMPT_KEY_PREFIX}abc`,
    );
  });
});

describe("writePendingAgentPrompt", () => {
  it("stores the message as fresh JSON the thread can autosubmit", () => {
    writePendingAgentPrompt("s1", "hello world");
    const raw = window.sessionStorage.getItem(pendingAgentPromptKey("s1"));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({
      text: "hello world",
      fresh: true,
    });
  });

  it("swallows storage failures instead of throwing", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => writePendingAgentPrompt("s2", "x")).not.toThrow();
  });
});

describe("clearPendingAgentPrompt", () => {
  it("removes a stashed payload", () => {
    writePendingAgentPrompt("s3", "bye");
    clearPendingAgentPrompt("s3");
    expect(
      window.sessionStorage.getItem(pendingAgentPromptKey("s3")),
    ).toBeNull();
  });

  it("is a no-op for a null/empty session id", () => {
    expect(() => clearPendingAgentPrompt(null)).not.toThrow();
    expect(() => clearPendingAgentPrompt(undefined)).not.toThrow();
    expect(() => clearPendingAgentPrompt("")).not.toThrow();
  });
});
