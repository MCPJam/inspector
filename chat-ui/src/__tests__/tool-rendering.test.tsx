import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ReadOnlyTranscript } from "../read-only-transcript";
import { Transcript } from "../read-only-transcript";
import { assistantParts, toolPart } from "./factories";

/** Tool cards start collapsed; a test about what one SHOWS has to open it. */
function openToolCards() {
  for (const header of screen.getAllByTestId("tool-card-header")) {
    if (header.getAttribute("aria-expanded") === "false") {
      fireEvent.click(header);
    }
  }
}

describe("tool rendering (read-only)", () => {
  it("renders tool name, input, and output statically", () => {
    const messages = [
      assistantParts([
        toolPart({
          toolName: "search",
          input: { query: "weather" },
          output: { temp: 72 },
        }),
      ]),
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);
    // Closed, the card is the tool's NAME and nothing else.
    expect(container.textContent).toContain("search");
    expect(container.textContent).not.toContain("\"query\": \"weather\"");

    openToolCards();
    expect(container.textContent).toContain("Input");
    expect(container.textContent).toContain("\"query\": \"weather\"");
    // Headed RESULT, the inspector's wording for it.
    expect(container.textContent).toContain("Result");
    expect(container.textContent).toContain("\"temp\": 72");
  });

  it("hands both raw payloads to a host's renderJson", () => {
    // The seam exists so the inspector can show tool payloads in the SAME
    // collapsible tree its Playground uses, instead of this package growing a
    // second copy of a component that already exists one layer up.
    const renderJson = vi.fn((_value: unknown, text: string) => (
      <div data-testid="host-json">{text}</div>
    ));
    const messages = [
      assistantParts([
        toolPart({
          toolName: "search",
          input: { query: "weather" },
          output: { temp: 72 },
        }),
      ]),
    ];

    const { container } = render(
      <ReadOnlyTranscript messages={messages} renderJson={renderJson} />,
    );
    openToolCards();

    // BOTH, not just input: the two call sites drifted apart once already
    // while only one had been switched over.
    expect(renderJson).toHaveBeenCalledTimes(2);
    expect(renderJson.mock.calls.map(([value]) => value)).toEqual([
      { query: "weather" },
      { temp: 72 },
    ]);
    // Handed the text the fold already measured, so a host that wants the
    // string does not stringify a large payload a second time.
    expect(renderJson.mock.calls[0][1]).toBe(
      JSON.stringify({ query: "weather" }, null, 2),
    );
    expect(container.querySelectorAll("[data-testid='host-json']")).toHaveLength(
      2,
    );
    // The package's own `<pre>` is REPLACED, not rendered beside it.
    expect(container.querySelector(".mcpjam-chat-json")).toBeNull();
  });

  it("leaves the readable result to Markdown, whatever renderJson is", () => {
    // `resultText` is prose, or output the adapter already fenced as ```json.
    // Sending it through a JSON viewer would undo exactly the translation it
    // exists to be (BB-198).
    const renderJson = vi.fn((_value: unknown, _text: string) => (
      <div data-testid="host-json" />
    ));
    const messages = [
      assistantParts([
        toolPart({
          toolName: "search",
          input: { query: "weather" },
          output: { temp: 72 },
          traceDisplayText: "It is 72 degrees and clear.",
        }),
      ]),
    ];

    const { container } = render(
      <ReadOnlyTranscript messages={messages} renderJson={renderJson} />,
    );
    openToolCards();

    expect(container.textContent).toContain("It is 72 degrees and clear.");
    // Input only — the raw output is not shown at all when a readable result
    // is present, so there is nothing for the second call to render.
    expect(renderJson).toHaveBeenCalledTimes(1);
    expect(renderJson.mock.calls[0][0]).toEqual({ query: "weather" });
  });

  it("still renders its own JSON view when no host seam is given", () => {
    const messages = [
      assistantParts([
        toolPart({ toolName: "search", input: { query: "weather" } }),
      ]),
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);
    openToolCards();
    expect(container.querySelector(".mcpjam-chat-json")).not.toBeNull();
  });

  it("renders error state instead of output", () => {
    const messages = [
      assistantParts([
        toolPart({
          toolName: "broken",
          state: "output-error",
          input: { a: 1 },
          errorText: "boom: it failed",
        }),
      ]),
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);
    expect(container.textContent).toContain("Error");
    expect(container.textContent).toContain("boom: it failed");
  });

  it("shows a widget placeholder for widget-bearing tools and mounts no widget", () => {
    const messages = [
      assistantParts([
        toolPart({ toolName: "weatherWidget", output: { temp: 72 } }),
      ]),
    ];
    const { container } = render(
      <ReadOnlyTranscript
        messages={messages}
        toolsMetadata={{
          weatherWidget: { "openai/outputTemplate": "ui://weather" },
        }}
      />,
    );
    const placeholder = container.querySelector(
      "[data-widget-placeholder='true']",
    );
    expect(placeholder).not.toBeNull();
    expect(placeholder?.textContent).toContain("read-only view");
    // The static tool block still renders alongside the placeholder.
    expect(container.textContent).toContain("weatherWidget");
  });

  it("hides the widget entirely when widgetPolicy='hidden'", () => {
    const messages = [
      assistantParts([toolPart({ toolName: "weatherWidget" })]),
    ];
    const { container } = render(
      <ReadOnlyTranscript
        messages={messages}
        widgetPolicy="hidden"
        toolsMetadata={{
          weatherWidget: { "openai/outputTemplate": "ui://weather" },
        }}
      />,
    );
    expect(
      container.querySelector("[data-widget-placeholder='true']"),
    ).toBeNull();
    expect(container.textContent).toContain("weatherWidget");
  });

  it("delegates widget rendering to a host-provided renderWidget", () => {
    const renderWidget = vi.fn(() => (
      <div data-testid="host-widget">HOST WIDGET</div>
    ));
    const messages = [
      assistantParts([toolPart({ toolName: "weatherWidget" })]),
    ];
    const { container } = render(
      <Transcript
        messages={messages}
        renderWidget={renderWidget}
        toolsMetadata={{
          weatherWidget: { "openai/outputTemplate": "ui://weather" },
        }}
      />,
    );
    expect(renderWidget).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid='host-widget']")).not.toBeNull();
    // No placeholder when the host renders its own widget.
    expect(
      container.querySelector("[data-widget-placeholder='true']"),
    ).toBeNull();
  });

  it("delegates the whole tool block to a host-provided renderTool", () => {
    const renderTool = vi.fn(() => (
      <div data-testid="host-tool">HOST TOOL BLOCK</div>
    ));
    const messages = [
      assistantParts([
        toolPart({ toolName: "search", output: { temp: 72 } }),
      ]),
    ];
    const { container } = render(
      <Transcript messages={messages} renderTool={renderTool} />,
    );
    expect(renderTool).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid='host-tool']")).not.toBeNull();
    // The static block is replaced, so its "Output" label is gone.
    expect(container.textContent).not.toContain("Output");
  });

  it("renders renderTool AND the widget placeholder for a widget-bearing tool", () => {
    const renderTool = vi.fn(() => <div data-testid="host-tool">HT</div>);
    const messages = [
      assistantParts([toolPart({ toolName: "weatherWidget" })]),
    ];
    const { container } = render(
      <Transcript
        messages={messages}
        renderTool={renderTool}
        toolsMetadata={{
          weatherWidget: { "openai/outputTemplate": "ui://weather" },
        }}
      />,
    );
    // renderTool replaces only the tool block; widget handling still runs.
    expect(container.querySelector("[data-testid='host-tool']")).not.toBeNull();
    expect(
      container.querySelector("[data-widget-placeholder='true']"),
    ).not.toBeNull();
  });

  it("renders both renderTool and renderWidget for a widget-bearing tool", () => {
    const renderTool = vi.fn(() => <div data-testid="host-tool">HT</div>);
    const renderWidget = vi.fn(() => <div data-testid="host-widget">HW</div>);
    const messages = [
      assistantParts([toolPart({ toolName: "weatherWidget" })]),
    ];
    const { container } = render(
      <Transcript
        messages={messages}
        renderTool={renderTool}
        renderWidget={renderWidget}
        toolsMetadata={{
          weatherWidget: { "openai/outputTemplate": "ui://weather" },
        }}
      />,
    );
    expect(container.querySelector("[data-testid='host-tool']")).not.toBeNull();
    expect(
      container.querySelector("[data-testid='host-widget']"),
    ).not.toBeNull();
    expect(
      container.querySelector("[data-widget-placeholder='true']"),
    ).toBeNull();
    expect(renderTool).toHaveBeenCalledTimes(1);
    expect(renderWidget).toHaveBeenCalledTimes(1);
  });
});
