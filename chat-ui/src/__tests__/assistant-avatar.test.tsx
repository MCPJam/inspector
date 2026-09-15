import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { ReadOnlyTranscript } from "../read-only-transcript";
import { assistantParts, userText } from "./factories";

/**
 * BB-239: Sessions put a generic `MessageCircle` bubble in front of every
 * assistant response, because `showAssistantAvatar` defaulted to `true` and no
 * session surface passed `false`. The Playground renderer has never drawn one.
 *
 * The default is now "whatever `renderAvatar` implies", so the three states
 * that matter are: nothing passed, a renderer passed alone, and an explicit
 * opt-in with no renderer.
 */
describe("assistant avatar", () => {
  const messages = [
    userText("What is MCP?"),
    assistantParts([{ type: "text", text: "Model Context Protocol." }]),
  ];

  const assistant = (container: HTMLElement) =>
    container.querySelector(".mcpjam-chat-message-assistant") as HTMLElement;

  it("draws no avatar by default", () => {
    const { container } = render(<ReadOnlyTranscript messages={messages} />);
    // The bubble is the only `svg` an assistant message with one text part
    // would carry, so its absence is the assertion.
    expect(assistant(container).querySelector("svg")).toBeNull();
  });

  it("gives the message no avatar gutter when there is no avatar", () => {
    const { container } = render(<ReadOnlyTranscript messages={messages} />);
    // `gap-4` spaces the text from an avatar that is not there; without it the
    // response starts at the transcript's own left edge, like the Playground.
    expect(assistant(container)).not.toHaveClass("gap-4");
  });

  it("shows a host avatar passed WITHOUT showAssistantAvatar", () => {
    // Requiring both props made this a silent no-op: an embedder supplying a
    // provider logo got nothing back and no error.
    const { container } = render(
      <ReadOnlyTranscript
        messages={messages}
        renderAvatar={(model) => (
          <img alt={model?.name ?? "Assistant"} src="/logo.png" />
        )}
      />
    );
    const avatar = container.querySelector("img");
    expect(avatar).not.toBeNull();
    expect(avatar).toHaveAttribute("alt", "Unknown");
    expect(assistant(container)).toHaveClass("gap-4");
  });

  it("lets an explicit false suppress a host avatar", () => {
    const { container } = render(
      <ReadOnlyTranscript
        messages={messages}
        showAssistantAvatar={false}
        renderAvatar={() => <img alt="Assistant" src="/logo.png" />}
      />
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders the built-in placeholder for an opt-in with no renderer", () => {
    const { container } = render(
      <ReadOnlyTranscript messages={messages} showAssistantAvatar />
    );
    // Labelled from the model, which `ReadOnlyTranscript` defaults to
    // DEFAULT_CHAT_UI_MODEL — hence "Unknown", not "Assistant".
    expect(
      assistant(container).querySelector("[aria-label='Unknown']")
    ).not.toBeNull();
    expect(assistant(container).querySelector("svg")).not.toBeNull();
  });
});
