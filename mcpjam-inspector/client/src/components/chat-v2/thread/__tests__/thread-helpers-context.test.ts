/**
 * The inspector's hidden-message rule: the package's `widget-state-` /
 * `model-context-` ids, plus widget state recognized by its header, which is
 * all a reopened conversation keeps of it (MJ-009).
 */
import { describe, expect, it } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import {
  buildSkillContextMessages,
  widgetStateContextText,
} from "@/shared/user-context-message";
import {
  getLastRenderableConversationMessage,
  getRenderableConversationMessages,
  isHiddenInternalMessage,
} from "../thread-helpers";

const text = (id: string, role: UIMessage["role"], value: string) =>
  ({ id, role, parts: [{ type: "text", text: value }] }) as UIMessage;

describe("hidden internal messages", () => {
  const reopenedWidgetState = text(
    "transcript-3-user-abc",
    "user",
    widgetStateContextText("call_1", { zoom: 2 }),
  );

  it("hides widget state by id and by header", () => {
    expect(
      isHiddenInternalMessage(text("widget-state-call_1", "user", "x")),
    ).toBe(true);
    expect(isHiddenInternalMessage(text("model-context-1", "user", "x"))).toBe(
      true,
    );
    expect(isHiddenInternalMessage(reopenedWidgetState)).toBe(true);
  });

  it("keeps the context the chat shows, and the user's own messages", () => {
    const [skill] = buildSkillContextMessages([
      { name: "brand", content: "Use the brand colors." },
    ]);
    expect(isHiddenInternalMessage(skill as UIMessage)).toBe(false);
    expect(isHiddenInternalMessage(text("u1", "user", "hello"))).toBe(false);
  });

  it("finds the last reply past a reopened widget state", () => {
    const messages = [
      text("u1", "user", "draw a chart"),
      text("a1", "assistant", "Here it is."),
      reopenedWidgetState,
    ];
    expect(getLastRenderableConversationMessage(messages)?.id).toBe("a1");
    expect(
      getRenderableConversationMessages(messages).map((message) => message.id),
    ).toEqual(["u1", "a1"]);
  });
});
