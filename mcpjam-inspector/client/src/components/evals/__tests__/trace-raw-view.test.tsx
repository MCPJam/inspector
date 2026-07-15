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
