import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadRememberedReasoningEffort,
  saveRememberedReasoningEffort,
} from "../reasoning-effort-storage";

describe("reasoning effort storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips per key and forgets on undefined", () => {
    saveRememberedReasoningEffort("hosted:openai/gpt-5", "high");
    saveRememberedReasoningEffort("local:openai:gpt-5", "low");
    expect(loadRememberedReasoningEffort("hosted:openai/gpt-5")).toBe("high");
    expect(loadRememberedReasoningEffort("local:openai:gpt-5")).toBe("low");
    saveRememberedReasoningEffort("hosted:openai/gpt-5", undefined);
    expect(loadRememberedReasoningEffort("hosted:openai/gpt-5")).toBeUndefined();
  });

  it("ignores corrupt or unknown stored values", () => {
    window.localStorage.setItem(
      "mcp-inspector-reasoning-efforts",
      JSON.stringify({ a: "turbo", b: "high" }),
    );
    expect(loadRememberedReasoningEffort("a")).toBeUndefined();
    expect(loadRememberedReasoningEffort("b")).toBe("high");
    window.localStorage.setItem("mcp-inspector-reasoning-efforts", "{oops");
    expect(loadRememberedReasoningEffort("b")).toBeUndefined();
  });

  it("does not throw when storage is unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadRememberedReasoningEffort("x")).toBeUndefined();
    spy.mockRestore();
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => saveRememberedReasoningEffort("x", "low")).not.toThrow();
    set.mockRestore();
  });
});
