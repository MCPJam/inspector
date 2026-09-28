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
    // The built-in bubble labels itself from the model, so this is the same
    // query the opt-in case below asserts POSITIVELY — which keeps the two
    // pinned against each other rather than against a utility class.
    expect(
      assistant(container).querySelector("[aria-label='Unknown']")
    ).toBeNull();
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
