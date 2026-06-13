import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { UIMessage } from "@ai-sdk/react";

import { ReadOnlyTranscript } from "../read-only-transcript";
import { assistantParts, userText } from "./factories";

describe("ReadOnlyTranscript", () => {
  it("renders user and assistant text with no providers", () => {
    const messages = [
      userText("What is MCP?"),
      assistantParts([{ type: "text", text: "Model Context Protocol." }]),
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);
    expect(container.textContent).toContain("What is MCP?");
    expect(container.textContent).toContain("Model Context Protocol.");
  });

  it("applies the package scope class and the dark theme class", () => {
    const { container } = render(
      <ReadOnlyTranscript messages={[userText("hi")]} themeMode="dark" />,
    );
    const root = container.querySelector(".mcpjam-chat-ui");
    expect(root).not.toBeNull();
    expect(root).toHaveClass("dark");
  });

  it("does not render a dark class for system theme", () => {
    const { container } = render(
      <ReadOnlyTranscript messages={[userText("hi")]} themeMode="system" />,
    );
    const root = container.querySelector(".mcpjam-chat-ui");
    expect(root).not.toBeNull();
    expect(root).not.toHaveClass("dark");
  });

  it("applies a light class for an explicit light theme (forces light over a dark host)", () => {
    const { container } = render(
      <ReadOnlyTranscript messages={[userText("hi")]} themeMode="light" />,
    );
    const root = container.querySelector(".mcpjam-chat-ui");
    expect(root).toHaveClass("light");
    expect(root).not.toHaveClass("dark");
  });

  it("skips hidden internal messages (widget-state-* / model-context-*)", () => {
    const messages = [
      userText("visible prompt", "u1"),
      {
        id: "widget-state-xyz",
        role: "user",
        parts: [{ type: "text", text: "SHOULD NOT RENDER" }],
      } as unknown as UIMessage,
      {
        id: "model-context-abc",
        role: "user",
        parts: [{ type: "text", text: "ALSO HIDDEN" }],
      } as unknown as UIMessage,
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);
    expect(container.textContent).toContain("visible prompt");
    expect(container.textContent).not.toContain("SHOULD NOT RENDER");
    expect(container.textContent).not.toContain("ALSO HIDDEN");
  });

  it("renders data-* parts as a JSON block", () => {
    const messages = [
      assistantParts([{ type: "data-result", data: { ok: true, count: 2 } }]),
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);
    expect(container.textContent).toContain("Result");
    expect(container.textContent).toContain("\"count\": 2");
  });
});
