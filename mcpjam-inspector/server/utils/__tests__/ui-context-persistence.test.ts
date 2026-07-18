/**
 * Persistence stores CONVERTED ModelMessages, so by the time history is
 * saved the orientation data part is already the text block the model read.
 * Left in, it reappears on reload as text the user seems to have typed.
 *
 * The risk in stripping it is the opposite one: deleting something the user
 * actually wrote. Hence exact whole-part matching, and these tests.
 */
import { describe, expect, it } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { stripUiContextModelParts } from "../web-chat-turn";
import { UI_CONTEXT_OPEN, renderUiContextText } from "@/shared/ui-context";

const RENDERED = renderUiContextText({
  path: "/servers",
  activeTab: "servers",
  timestamp: "2026-07-15T12:00:00.000Z",
})!;

function userMsg(...content: unknown[]): ModelMessage {
  return { role: "user", content } as ModelMessage;
}

describe("stripUiContextModelParts", () => {
  it("removes a rendered context block, keeping the user's message", () => {
    const out = stripUiContextModelParts([
      userMsg(
        { type: "text", text: RENDERED },
        { type: "text", text: "connect everything" },
      ),
    ]);
    expect(out[0].content).toEqual([
      { type: "text", text: "connect everything" },
    ]);
  });

  it("does NOT touch user text that merely mentions the marker", () => {
    const authored = `what does ${UI_CONTEXT_OPEN} mean?`;
    const out = stripUiContextModelParts([userMsg({ type: "text", text: authored })]);
    expect(out[0].content).toEqual([{ type: "text", text: authored }]);
  });

  it("leaves assistant messages alone even if they quote a block", () => {
    // Only user messages ever carry one; an assistant quoting it is content.
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: RENDERED }],
    } as ModelMessage;
    expect(stripUiContextModelParts([assistant])).toEqual([assistant]);
  });

  it("returns the same array reference when nothing matched", () => {
    // Persistence runs on every turn; don't churn history for nothing.
    const messages = [userMsg({ type: "text", text: "hello" })];
    expect(stripUiContextModelParts(messages)).toBe(messages);
  });

  it("handles string content and tool messages without throwing", () => {
    const messages = [
      { role: "user", content: "plain string" } as ModelMessage,
      { role: "tool", content: [] } as unknown as ModelMessage,
    ];
    expect(stripUiContextModelParts(messages)).toEqual(messages);
  });

  it("strips a block from every turn in a long session", () => {
    const out = stripUiContextModelParts([
      userMsg({ type: "text", text: RENDERED }, { type: "text", text: "one" }),
      { role: "assistant", content: [{ type: "text", text: "ok" }] } as ModelMessage,
      userMsg({ type: "text", text: RENDERED }, { type: "text", text: "two" }),
    ]);
    const userTexts = out
      .filter((m) => m.role === "user")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .map((p: any) => p.text);
    expect(userTexts).toEqual(["one", "two"]);
  });
});
