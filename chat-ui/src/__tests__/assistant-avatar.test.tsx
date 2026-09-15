import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { ReadOnlyTranscript } from "../read-only-transcript";
import { assistantParts, userText } from "./factories";

/**
 * BB-239: Sessions put a generic `MessageCircle` bubble in front of every
 * assistant response, because `showAssistantAvatar` defaulted to `true` and no
 * session surface passed `false`. The Playground renderer has never drawn one,
 * so the default was the thing making two views of one conversation look like
 * two products.
 */
describe("assistant avatar", () => {
  const messages = [
    userText("What is MCP?"),
    assistantParts([{ type: "text", text: "Model Context Protocol." }]),
  ];

  it("draws no avatar by default", () => {
    const { container } = render(<ReadOnlyTranscript messages={messages} />);
    const assistant = container.querySelector(
      ".mcpjam-chat-message-assistant"
    ) as HTMLElement;
    expect(assistant).not.toBeNull();
    // The generic bubble is the only `svg` an assistant message with a single
    // text part would carry, so its absence is the assertion.
    expect(assistant.querySelector("svg")).toBeNull();
    expect(assistant.querySelector("[aria-label='Assistant']")).toBeNull();
  });

  it("still lets a host opt in, and render its own", () => {
    const { container } = render(
      <ReadOnlyTranscript
        messages={messages}
        showAssistantAvatar
        renderAvatar={(model) => (
          <img alt={model?.name ?? "Assistant"} src="/logo.png" />
        )}
      />
    );
    const avatar = container.querySelector("img");
    expect(avatar).not.toBeNull();
    expect(avatar).toHaveAttribute("alt", "Unknown");
  });

  it("gives the assistant message no avatar gutter when the avatar is off", () => {
    const { container } = render(<ReadOnlyTranscript messages={messages} />);
    const assistant = container.querySelector(".mcpjam-chat-message-assistant");
    // `gap-4` spaces the message from an avatar that is not there; with none,
    // the text should start at the transcript's own left edge — the visual
    // difference a reader actually notices next to the Playground.
    expect(assistant).not.toHaveClass("gap-4");
  });
});
