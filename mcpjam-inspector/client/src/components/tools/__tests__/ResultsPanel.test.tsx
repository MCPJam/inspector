import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ResultsPanel } from "../ResultsPanel";

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({ value }: { value: unknown }) => (
    <pre data-testid="json-editor">{JSON.stringify(value)}</pre>
  ),
}));

const withStructured = {
  content: [{ type: "text", text: "raw text" }],
  structuredContent: { greeting: "hello" },
} as any;

const withStructured2 = {
  content: [{ type: "text", text: "raw text 2" }],
  structuredContent: { greeting: "hello-2" },
} as any;

const rawOnly = { content: [{ type: "text", text: "only raw" }] } as any;

describe("ResultsPanel", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("defaults to structured output when structuredContent exists", () => {
    render(
      <ResultsPanel
        error=""
        result={withStructured}
        structuredContentValid={undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Structured" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Raw" })).toBeInTheDocument();
    expect(screen.getByTestId("json-editor")).toHaveTextContent(
      JSON.stringify({ greeting: "hello" }),
    );
  });

  it("switches to raw output when raw mode is selected", () => {
    render(
      <ResultsPanel
        error=""
        result={withStructured}
        structuredContentValid={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));

    expect(screen.getByTestId("json-editor")).toHaveTextContent(
      JSON.stringify(withStructured),
    );
  });

  it("keeps raw mode selected across result updates when structuredContent exists", () => {
    const { rerender } = render(
      <ResultsPanel
        error=""
        result={withStructured}
        structuredContentValid={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));

    rerender(
      <ResultsPanel
        error=""
        result={withStructured2}
        structuredContentValid={undefined}
      />,
    );

    expect(screen.getByTestId("json-editor")).toHaveTextContent(
      JSON.stringify(withStructured2),
    );
  });

  it("falls back to raw mode if structuredContent becomes unavailable", () => {
    const { rerender } = render(
      <ResultsPanel
        error=""
        result={withStructured}
        structuredContentValid={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Structured" }));

    rerender(
      <ResultsPanel
        error=""
        result={rawOnly}
        structuredContentValid={undefined}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Structured" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("json-editor")).toHaveTextContent(
      JSON.stringify(rawOnly),
    );
  });

  it("restores structured output when structuredContent returns after a raw-only result", () => {
    const { rerender } = render(
      <ResultsPanel
        error=""
        result={withStructured}
        structuredContentValid={undefined}
      />,
    );

    rerender(
      <ResultsPanel
        error=""
        result={rawOnly}
        structuredContentValid={undefined}
      />,
    );

    rerender(
      <ResultsPanel
        error=""
        result={withStructured2}
        structuredContentValid={undefined}
      />,
    );

    expect(screen.getByTestId("json-editor")).toHaveTextContent(
      JSON.stringify({ greeting: "hello-2" }),
    );
  });

  it("restores raw output when structuredContent returns if user previously selected raw", () => {
    const { rerender } = render(
      <ResultsPanel
        error=""
        result={withStructured}
        structuredContentValid={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));

    rerender(
      <ResultsPanel
        error=""
        result={rawOnly}
        structuredContentValid={undefined}
      />,
    );

    rerender(
      <ResultsPanel
        error=""
        result={withStructured2}
        structuredContentValid={undefined}
      />,
    );

    expect(screen.getByTestId("json-editor")).toHaveTextContent(
      JSON.stringify(withStructured2),
    );
  });

  it("keeps user-selected mode after unmount/remount (close and reopen tool)", () => {
    const { unmount } = render(
      <ResultsPanel
        error=""
        result={withStructured}
        structuredContentValid={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(screen.getByTestId("json-editor")).toHaveTextContent(
      JSON.stringify(withStructured),
    );

    unmount();

    render(
      <ResultsPanel
        error=""
        result={withStructured2}
        structuredContentValid={undefined}
      />,
    );

    expect(screen.getByTestId("json-editor")).toHaveTextContent(
      JSON.stringify(withStructured2),
    );
  });

  it("does not render output mode toggle when structuredContent is absent", () => {
    render(
      <ResultsPanel
        error=""
        result={rawOnly}
        structuredContentValid={undefined}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Structured" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("json-editor")).toHaveTextContent(
      JSON.stringify(rawOnly),
    );
  });
});
