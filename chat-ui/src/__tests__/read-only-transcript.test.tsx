import { describe, it, expect, vi } from "vitest";
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
      <ReadOnlyTranscript messages={[userText("hi")]} themeMode="dark" />
    );
    const root = container.querySelector(".mcpjam-chat-ui");
    expect(root).not.toBeNull();
    expect(root).toHaveClass("dark");
  });

  it("does not render a dark class for system theme", () => {
    const { container } = render(
      <ReadOnlyTranscript messages={[userText("hi")]} themeMode="system" />
    );
    const root = container.querySelector(".mcpjam-chat-ui");
    expect(root).not.toBeNull();
    expect(root).not.toHaveClass("dark");
  });

  it("applies a light class for an explicit light theme (forces light over a dark host)", () => {
    const { container } = render(
      <ReadOnlyTranscript messages={[userText("hi")]} themeMode="light" />
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
    expect(container.textContent).toContain('"count": 2');
  });
});

describe("ReadOnlyTranscript renderTurnFooter", () => {
  it("renders the footer under assistant messages only", () => {
    const messages = [
      userText("What is MCP?"),
      assistantParts([{ type: "text", text: "Model Context Protocol." }]),
    ];
    const { container } = render(
      <ReadOnlyTranscript
        messages={messages}
        renderTurnFooter={(message) => (
          <span data-testid="footer">footer:{message.role}</span>
        )}
      />
    );
    const footers = container.querySelectorAll("[data-testid='footer']");
    expect(footers).toHaveLength(1);
    expect(footers[0]!.textContent).toBe("footer:assistant");
  });

  it("passes the VISIBLE index, not the raw messages index", () => {
    // Hosts join per-turn scores by counting prompts in the filtered array, so
    // handing them the raw index would offset every rating by however many
    // hidden internal messages the thread happens to carry.
    const hidden = userText("injected context", "model-context-1");
    const messages = [
      userText("first", "u1"),
      assistantParts([{ type: "text", text: "a" }], "a1"),
      hidden,
      userText("second", "u2"),
      assistantParts([{ type: "text", text: "b" }], "a2"),
    ];
    const seen: number[] = [];
    render(
      <ReadOnlyTranscript
        messages={messages}
        renderTurnFooter={(_message, index) => {
          seen.push(index);
          return null;
        }}
      />
    );
    // Two assistant messages at visible positions 1 and 3 — the hidden message
    // was dropped before indexing, so the second one is 3 and not 4.
    expect(seen).toEqual([1, 3]);
  });

  it("passes the footer by reference so MessageView's memo still holds", () => {
    // A per-message arrow built in this render would change identity every
    // pass and defeat `memo` for the whole transcript. The index travels as a
    // separate prop precisely so the function can be passed through.
    const renderTurnFooter = vi.fn(() => null);
    const messages = [
      userText("hi"),
      assistantParts([{ type: "text", text: "hello" }]),
    ];
    const { rerender } = render(
      <ReadOnlyTranscript
        messages={messages}
        renderTurnFooter={renderTurnFooter}
      />
    );
    const callsAfterFirst = renderTurnFooter.mock.calls.length;

    // Same messages, same callback, unrelated prop change.
    rerender(
      <ReadOnlyTranscript
        messages={messages}
        renderTurnFooter={renderTurnFooter}
        className="changed"
      />
    );

    expect(renderTurnFooter.mock.calls.length).toBe(callsAfterFirst);
  });
});
