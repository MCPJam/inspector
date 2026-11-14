import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { withHarnessTurnContext, unavailableAppToolsSpan } from "../harness-turn-input";
import { renderUserContextText, widgetStateContextText } from "@/shared/user-context-message";

describe("harness per-turn App context", () => {
  it.each(["skill", "tool-run"] as const)("delivers current widget state and pending %s context in the last prompt", (kind) => {
    const state = widgetStateContextText("call-1", { selected: 2 });
    const context = renderUserContextText({ kind, subject: "selected-context", body: "context from the user" });
    const messages: ModelMessage[] = [
      { role: "system", content: "stable instructions" },
      { role: "user", content: state },
      { role: "assistant", content: "previous response" },
      { role: "user", content: context },
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
  it.each([false, true])("does not replay a stopped prompt into the next turn (prior assistant %s)", (hasAssistant) => {
    const messages: ModelMessage[] = [
      ...(hasAssistant ? [{ role: "assistant" as const, content: "Previous completed response." }] : []),
      { role: "user", content: "Call record_write with marker cancelled-write." },
      { role: "user", content: "Reply with the sum of 7 and 3, using only the number." },
    ];
    const result = withHarnessTurnContext(messages);
    expect(result).toBe(messages);
    expect(result.at(-1)).toEqual(messages.at(-1));
    expect(JSON.stringify(result.at(-1))).not.toContain("cancelled-write");
  });

  it("preserves current App state while excluding an interrupted ordinary prompt", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: widgetStateContextText("call-1", { selected: 2 }) },
      { role: "user", content: "Call record_write with marker cancelled-write." },
      { role: "user", content: "Reply with 10." },
    ];
    const result = withHarnessTurnContext(messages, "current App model context");
    const prompt = JSON.stringify(result.at(-1));
    expect(prompt).toContain("Widget state reported by an app");
    expect(prompt).toContain("current App model context");
    expect(prompt).toContain("Reply with 10.");
    expect(prompt).not.toContain("cancelled-write");
    expect(messages.at(-1)?.content).toBe("Reply with 10.");
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
    expect(unavailableAppToolsSpan(1).name).toBe("1 App-provided tool is unavailable in this agent runtime.");
    expect(unavailableAppToolsSpan(2).name).toBe("2 App-provided tools are unavailable in this agent runtime.");
  });
});
