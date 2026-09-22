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
  it("labels saved context and preserves the recorded evidence", () => {
    renderWithProviders(
      <TraceRawView trace={{ traceVersion: 1, messages: [], recordedContext: { modelId: "z-ai/glm-4.5" } } as never} />,
    );
    expect(screen.getByTestId("trace-raw-recorded-context")).toHaveTextContent("Saved session evidence");
    expect(screen.getByTestId("json-editor")).toHaveTextContent("z-ai/glm-4.5");
  });

  it("does not label a live request payload as saved session evidence", () => {
    renderWithProviders(
      <TraceRawView
        trace={{ traceVersion: 1, messages: [], recordedContext: { modelId: "z-ai/glm-4.5" } } as never}
        requestPayloadHistory={{ entries: [makeEntry(0, "System")], hasUiMessages: true }}
      />,
    );
    expect(screen.queryByTestId("trace-raw-recorded-context")).not.toBeInTheDocument();
    expect(screen.getByTestId("json-editor")).toHaveTextContent("System");
  });

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

describe("TraceRawView — saved requests", () => {
  /**
   * A saved session's Raw reads like the Playground's: the request that was
   * sent, with the conversation merged in from the transcript. A capped entry
   * lost its own copy of `messages`; the transcript stands in for it.
   */
  const truncatedEntry = {
    turnId: "turn-1",
    promptIndex: 0,
    stepIndex: 0,
    payload: { system: "stored system", tools: {}, messages: [] },
    truncated: true as const,
    messageCount: 9,
  };

  it("merges the transcript into a capped request, as the Playground does", () => {
    renderWithProviders(
      <TraceRawView
        trace={
          {
            messages: [
              { role: "user", content: "question" },
              { role: "assistant", content: "later response" },
            ],
            recordedContext: {},
          } as never
        }
        requestPayloadHistory={{ entries: [truncatedEntry], hasUiMessages: false }}
      />,
    );
    const json = screen.getByTestId("json-editor");
    expect(json).toHaveTextContent("stored system");
    expect(json).toHaveTextContent("later response");
    expect(json).toHaveTextContent('"truncated": true');
    expect(json).not.toHaveTextContent("messageCount");
    expect(
      screen.queryByTestId("trace-raw-recorded-context"),
    ).not.toBeInTheDocument();
  });

  it("says how many messages were dropped when there is no transcript to stand in", () => {
    renderWithProviders(
      <TraceRawView
        trace={{ messages: [] } as never}
        requestPayloadHistory={{ entries: [truncatedEntry], hasUiMessages: false }}
      />,
    );
    const json = screen.getByTestId("json-editor");
    expect(json).toHaveTextContent('"messageCount": 9');
    expect(json).not.toHaveTextContent('"messages"');
  });
});

describe("TraceRawView — fallback note", () => {
  const evidence = {
    messages: [{ role: "user", content: "stored" }],
    recordedContext: {},
  };

  it("says requests are unavailable only once nothing is still loading", () => {
    const { rerender } = renderWithProviders(
      <TraceRawView
        trace={{ ...evidence, requestPayloadsPending: true } as never}
      />,
    );
    expect(
      screen.queryByTestId("trace-raw-recorded-context"),
    ).not.toBeInTheDocument();

    rerender(<TraceRawView trace={evidence as never} />);
    expect(screen.getByTestId("trace-raw-recorded-context")).toBeInTheDocument();
  });

  it("says a failed read failed, instead of claiming none were saved", () => {
    renderWithProviders(
      <TraceRawView
        trace={
          {
            ...evidence,
            requestPayloadsError: "Saved model requests could not be loaded",
          } as never
        }
      />,
    );
    expect(screen.getByTestId("trace-raw-request-error")).toHaveTextContent(
      "could not be loaded",
    );
    expect(
      screen.queryByTestId("trace-raw-recorded-context"),
    ).not.toBeInTheDocument();
  });

  it("stays quiet for a trace with no recorded context", () => {
    renderWithProviders(<TraceRawView trace={{ messages: [] } as never} />);
    expect(
      screen.queryByTestId("trace-raw-recorded-context"),
    ).not.toBeInTheDocument();
  });
});
