import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { extractUserMessageText } from "../chat-helpers";
import { messagePartPlainText } from "@/shared/plugin-message";

const message = (parts: UIMessage["parts"]): UIMessage => ({
  id: "fixture",
  role: "user",
  parts,
});
const titled = {
  type: "data-plugin-message-text" as const,
  data: { title: "Visible title", text: "Underlying prompt" },
};

describe("user prompt previews", () => {
  it("uses the first underlying text for a titled App item", () => {
    expect(
      extractUserMessageText(
        message([titled, { type: "text", text: "Second block" }]),
      ),
    ).toBe("Underlying prompt");
  });
  it("retains ordinary first-part behavior and ignores attachments", () => {
    expect(
      extractUserMessageText(
        message([
          {
            type: "file",
            mediaType: "image/png",
            url: "data:image/png;base64,AAAA",
          },
          { type: "text", text: "Plain prompt" },
          titled,
        ]),
      ),
    ).toBe("Plain prompt");
  });
  it.each([
    { ...titled, data: { title: "Visible title", text: 42 } },
    { ...titled, data: { title: "x".repeat(257), text: "Underlying prompt" } },
    { ...titled, data: { ...titled.data, instanceToken: "private" } },
    { type: "data-other", data: titled.data },
  ])("ignores malformed/foreign data parts %#", (part) => {
    expect(messagePartPlainText(part)).toBeUndefined();
    expect(
      extractUserMessageText(
        message([part as never, { type: "text", text: "Fallback" }]),
      ),
    ).toBe("Fallback");
  });
});
