import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { withHarnessTurnContext, unavailableAppToolsSpan } from "../harness-turn-input";
import { widgetStateContextText } from "@/shared/user-context-message";

describe("harness per-turn App context", () => {
  it("delivers current widget state and pending user context in the last prompt", () => {
    const state = widgetStateContextText("call-1", { selected: 2 });
    const messages: ModelMessage[] = [
      { role: "system", content: "stable instructions" },
      { role: "user", content: state },
      { role: "assistant", content: "previous response" },
      { role: "user", content: "context from the user" },
      { role: "user", content: "continue" },
    ];
    const result = withHarnessTurnContext(messages, "current App model context");
    expect(result[0]).toBe(messages[0]);
    const last = result.at(-1);
    expect(last?.role).toBe("user");
    expect(JSON.stringify(last)).toContain("Widget state reported by an app");
    expect(JSON.stringify(result.at(-1))).toContain("context from the user");
    expect(JSON.stringify(result.at(-1))).not.toContain("previous response");
    expect(messages.at(-1)?.content).toBe("continue");
  });
  it("replaces the per-turn prefix without modifying session instructions", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "continue" }];
    const first = withHarnessTurnContext(messages, "state one");
    const second = withHarnessTurnContext(messages, "state two");
    expect(JSON.stringify(first)).toContain("state one");
    expect(JSON.stringify(second)).toContain("state two");
    expect(JSON.stringify(second)).not.toContain("state one");
  });
  it("records unavailable tools as discovery information", () => {
    expect(unavailableAppToolsSpan()).toMatchObject({ category: "discovery", status: "ok" });
  });
});
