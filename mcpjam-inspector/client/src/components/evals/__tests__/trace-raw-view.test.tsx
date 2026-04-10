import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { TraceRawView } from "../trace-raw-view";

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({ value }: { value: unknown }) => (
    <pre data-testid="json-editor">{JSON.stringify(value, null, 2)}</pre>
  ),
}));

vi.mock("@/components/ui/select", () => {
  const SelectTrigger = ({
    children,
    ...props
  }: React.PropsWithChildren<Record<string, unknown>>) => (
    <mock-select-trigger {...props}>{children}</mock-select-trigger>
  );

  const SelectContent = ({
    children,
  }: React.PropsWithChildren<Record<string, unknown>>) => (
    <mock-select-content>{children}</mock-select-content>
  );

  const SelectItem = ({
    value,
    children,
  }: React.PropsWithChildren<{ value: string }>) => (
    <option value={value}>{children}</option>
  );

  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: React.PropsWithChildren<{
      value?: string;
      onValueChange?: (value: string) => void;
    }>) => {
      const childArray = React.Children.toArray(children);
      const trigger = childArray.find(
        (child) =>
          React.isValidElement(child) && child.type === SelectTrigger,
      );
      const content = childArray.find(
        (child) =>
          React.isValidElement(child) && child.type === SelectContent,
      ) as React.ReactElement | undefined;
      const options = React.Children.toArray(content?.props.children);
      const ariaLabel = React.isValidElement(trigger)
        ? (trigger.props["aria-label"] as string | undefined)
        : undefined;

      return (
        <select
          aria-label={ariaLabel}
          value={value ?? ""}
          onChange={(event) => onValueChange?.(event.target.value)}
        >
          {options}
        </select>
      );
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent,
    SelectItem,
  };
});

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
  it("defaults to the latest payload and only shows the selector for multiple entries", () => {
    const { rerender } = renderWithProviders(
      <TraceRawView
        trace={null}
        requestPayloadHistory={{
          entries: [makeEntry(0, "System 1"), makeEntry(1, "System 2")],
          hasUiMessages: true,
        }}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Select request payload" }))
      .toBeTruthy();
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

    expect(
      screen.queryByRole("combobox", { name: "Select request payload" }),
    ).toBeNull();
    expect(screen.getByTestId("json-editor")).toHaveTextContent("System 1");
  });

  it("preserves a manual selection for the same history and resets to latest when history changes", async () => {
    const user = userEvent.setup();
    const initialHistory = {
      entries: [makeEntry(0, "System 1"), makeEntry(1, "System 2")],
      hasUiMessages: true,
    };
    const { rerender } = renderWithProviders(
      <TraceRawView trace={null} requestPayloadHistory={initialHistory} />,
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Select request payload" }),
      "turn-1:0",
    );

    expect(screen.getByTestId("json-editor")).toHaveTextContent("System 1");

    rerender(
      <TraceRawView trace={null} requestPayloadHistory={initialHistory} />,
    );

    expect(screen.getByTestId("json-editor")).toHaveTextContent("System 1");

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
});
