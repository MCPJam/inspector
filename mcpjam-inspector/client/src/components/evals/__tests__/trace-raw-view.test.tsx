import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { TraceRawView } from "../trace-raw-view";

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({ value }: { value: unknown }) => (
    <pre data-testid="json-editor">{JSON.stringify(value, null, 2)}</pre>
  ),
}));

function makeEntry(stepIndex: number, system: string) {
  return {
    turnId: "turn-1",
    promptIndex: 0,
    stepIndex,
    payload: {
      system,
      tools: {},
      messages: [{ role: "user", content: `message-${stepIndex}` }],
    },
  };
}

describe("TraceRawView scroll-edge fade", () => {
  /**
   * The session detail asked for it: Raw ended at a hard edge that cut a line
   * mid-token and said nothing about whether that was the end. The class has
   * to land on the element that actually SCROLLS — `scroll-fade-y` is a
   * scroll-driven animation reading `scroll(self y)`, so on the wrapper above
   * it (which is `overflow-hidden`) it would simply never animate.
   */
  function scroller(container: HTMLElement) {
    return container.querySelector(".overflow-auto");
  }

  it("fades the scrolling element when asked", () => {
    const { container } = renderWithProviders(
      <TraceRawView trace={{ spans: [] } as never} fadeScrollEdges />,
    );

    const node = scroller(container);
    expect(node).not.toBeNull();
    expect(node!.className).toContain("scroll-fade-y");
  });

  it("leaves every other surface alone by default", () => {
    // Raw is rendered on eval runs, the Playground's trace pane and swarm
    // sessions too. Opt-in means those are untouched until their owners ask.
    const { container } = renderWithProviders(
      <TraceRawView trace={{ spans: [] } as never} />,
    );

    expect(scroller(container)!.className).not.toContain("scroll-fade-y");
  });

  it("does not fade a grow-with-content Raw view", () => {
    // That branch has no scrollport of its own — the page around it scrolls —
    // so a mask there would dim edges nothing is moving past.
    const { container } = renderWithProviders(
      <TraceRawView
        trace={null}
        requestPayloadHistory={{
          entries: [makeEntry(0, "System 1")],
          hasUiMessages: true,
        }}
        growWithContent
        fadeScrollEdges
      />,
    );

    expect(container.querySelector(".scroll-fade-y")).toBeNull();
  });
});

describe("TraceRawView", () => {
  it("shows the latest request payload for live history (no turn/step header)", () => {
    const { rerender } = renderWithProviders(
      <TraceRawView
        trace={null}
        requestPayloadHistory={{
          entries: [makeEntry(0, "System 1"), makeEntry(1, "System 2")],
          hasUiMessages: true,
        }}
      />,
    );

    expect(
      screen.queryByRole("combobox", { name: "Select request payload" }),
    ).toBeNull();
    expect(screen.getByTestId("json-editor")).toHaveTextContent("System 2");

    rerender(
      <TraceRawView
        trace={null}
        requestPayloadHistory={{
          entries: [makeEntry(0, "System 1")],
          hasUiMessages: true,
        }}
      />,
    );

    expect(screen.getByTestId("json-editor")).toHaveTextContent("System 1");
  });

  it("when history grows, Raw follows the latest entry", () => {
    const { rerender } = renderWithProviders(
      <TraceRawView
        trace={null}
        requestPayloadHistory={{
          entries: [makeEntry(0, "System 1"), makeEntry(1, "System 2")],
          hasUiMessages: true,
        }}
      />,
    );

    expect(screen.getByTestId("json-editor")).toHaveTextContent("System 2");

    rerender(
      <TraceRawView
        trace={null}
        requestPayloadHistory={{
          entries: [
            makeEntry(0, "System 1"),
            makeEntry(1, "System 2"),
            makeEntry(2, "System 3"),
          ],
          hasUiMessages: true,
        }}
      />,
    );

    expect(screen.getByTestId("json-editor")).toHaveTextContent("System 3");
  });

  it("merges live trace envelope messages so the latest assistant is visible before the next user message", () => {
    const outgoingPayload = {
      system: "You are a helpful assistant.",
      tools: {},
      messages: [
        { role: "user" as const, content: "hi" },
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "Hello." }],
        },
        { role: "user" as const, content: "follow up" },
      ],
    };
    const trace = {
      traceVersion: 1 as const,
      messages: [
        ...outgoingPayload.messages,
        {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "Here is the reply to the follow up." },
          ],
        },
      ],
    };

    renderWithProviders(
      <TraceRawView
        trace={trace}
        requestPayloadHistory={{
          entries: [
            {
              turnId: "turn-1",
              promptIndex: 0,
              stepIndex: 0,
              payload: outgoingPayload,
            },
          ],
          hasUiMessages: true,
        }}
      />,
    );

    expect(screen.getByTestId("json-editor")).toHaveTextContent(
      "Here is the reply to the follow up.",
    );
  });

  it("annotates the request with the harness's built-in tools when provided", () => {
    renderWithProviders(
      <TraceRawView
        trace={null}
        requestPayloadHistory={{
          entries: [makeEntry(0, "System 1")],
          hasUiMessages: true,
        }}
        harnessBuiltinTools={[
          { key: "bash", name: "Bash", description: "run shell commands" },
          { key: "read", name: "Read", description: "read files" },
        ]}
      />,
    );

    expect(screen.getByText(/inside the sandbox/i)).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
  });

  it("shows no harness annotation for non-harness hosts (shared reuse stays clean)", () => {
    renderWithProviders(
      <TraceRawView
        trace={null}
        requestPayloadHistory={{
          entries: [makeEntry(0, "System 1")],
          hasUiMessages: true,
        }}
      />,
    );

    expect(screen.queryByText(/inside the sandbox/i)).toBeNull();
  });

  it("falls back to the trace blob when request payload history is empty (e.g. rehydrated session)", () => {
    const trace = {
      traceVersion: 1 as const,
      messages: [{ role: "user" as const, content: "stored" }],
    };

    renderWithProviders(
      <TraceRawView
        trace={trace}
        requestPayloadHistory={{
          entries: [],
          hasUiMessages: true,
        }}
      />,
    );

    expect(screen.getByTestId("json-editor")).toHaveTextContent("stored");
  });
});
