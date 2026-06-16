import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

import { ReadOnlyTranscript } from "../read-only-transcript";
import { Transcript } from "../read-only-transcript";
import { assistantParts, toolPart } from "./factories";

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
    expect(container.textContent).toContain("search");
    expect(container.textContent).toContain("Input");
    expect(container.textContent).toContain("\"query\": \"weather\"");
    expect(container.textContent).toContain("Output");
    expect(container.textContent).toContain("\"temp\": 72");
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
