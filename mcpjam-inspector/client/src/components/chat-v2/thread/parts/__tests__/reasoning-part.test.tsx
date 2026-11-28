import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReasoningPart } from "../reasoning-part";

describe("ReasoningPart", () => {
  it("renders reasoning inline by default", () => {
    render(<ReasoningPart text="Reasoned response" />);

    expect(screen.getByText("Reasoned response")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /reasoning/i }),
    ).not.toBeInTheDocument();
  });

  it("collapses reasoning in trace mode and expands on demand", () => {
    render(
      <ReasoningPart
        text="Private reasoning for trace viewers"
        displayMode="collapsed"
      />,
    );

    const toggle = screen.getByRole("button", { name: /reasoning/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText("Private reasoning for trace viewers"),
    ).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("Private reasoning for trace viewers"),
    ).toBeInTheDocument();
  });

  it("shows collapsible reasoning expanded by default", () => {
    render(
      <ReasoningPart text="Owner thread reasoning" displayMode="collapsible" />,
    );

    const toggle = screen.getByRole("button", { name: /reasoning/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Owner thread reasoning")).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText("Owner thread reasoning"),
    ).not.toBeInTheDocument();
  });

  it("hides reasoning when display mode is hidden", () => {
    const { container } = render(
      <ReasoningPart
        text="Not for public scenario viewers"
        displayMode="hidden"
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("hides redacted reasoning", () => {
    const { container } = render(<ReasoningPart text="[REDACTED]" />);

    expect(container.firstChild).toBeNull();
  });

  it("shimmers the label while reasoning streams", () => {
    // A still-running turn must be visibly distinguishable from a hung one,
    // even when the reader has closed the block. The motion lives on the
    // label itself, so assert the class is actually on the text node and not
    // merely somewhere in the header.
    render(
      <ReasoningPart
        text="Working through the request"
        state="streaming"
        displayMode="collapsed"
      />,
    );

    expect(screen.getByText("Thinking…")).toHaveClass("reasoning-shimmer-text");
  });

  it("shows the Thinking header for a streaming block with no text yet", () => {
    render(<ReasoningPart text="" state="streaming" displayMode="collapsed" />);

    expect(screen.getByText("Thinking…")).toHaveClass("reasoning-shimmer-text");
  });

  it("renders nothing for an empty block once it is done", () => {
    const { container } = render(
      <ReasoningPart text="" state="done" displayMode="collapsed" />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("stops shimmering once reasoning is done", () => {
    // A shimmer on a finished label would advertise work that is no longer
    // happening.
    render(
      <ReasoningPart
        text="Working through the request"
        state="done"
        displayMode="collapsed"
      />,
    );

    expect(screen.getByText("Reasoning")).not.toHaveClass(
      "reasoning-shimmer-text",
    );
  });

  it("opens while reasoning streams and stays open once it is done", () => {
    // A closed block that only shimmers read as a stall: the thinking itself
    // shows while it streams, and stays for the reader once it is done.
    const { rerender } = render(
      <ReasoningPart
        text="First thought"
        state="streaming"
        displayMode="collapsed"
      />,
    );

    expect(screen.getByRole("button", { name: /thinking/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("First thought")).toBeInTheDocument();

    // More text streams in: still open, showing all of it.
    rerender(
      <ReasoningPart
        text="First thought and then a second one"
        state="streaming"
        displayMode="collapsed"
      />,
    );
    expect(
      screen.getByText("First thought and then a second one"),
    ).toBeInTheDocument();

    rerender(
      <ReasoningPart
        text="First thought and then a second one"
        state="done"
        displayMode="collapsed"
      />,
    );

    expect(screen.getByRole("button", { name: /reasoning/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      screen.getByText("First thought and then a second one"),
    ).toBeInTheDocument();
  });

  it("starts closed for reasoning that is already done", () => {
    // A reloaded chat or a finished turn: nothing is streaming.
    render(
      <ReasoningPart
        text="Earlier reasoning"
        state="done"
        displayMode="collapsed"
      />,
    );

    expect(screen.getByRole("button", { name: /reasoning/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps a block the reader closed while it streams closed", () => {
    const { rerender } = render(
      <ReasoningPart
        text="First thought"
        state="streaming"
        displayMode="collapsed"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /thinking/i }));

    // New text must not reopen a panel the reader closed.
    rerender(
      <ReasoningPart
        text="First thought and then a second one"
        state="streaming"
        displayMode="collapsed"
      />,
    );
    expect(screen.getByRole("button", { name: /thinking/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // Nor finishing.
    rerender(
      <ReasoningPart
        text="First thought and then a second one"
        state="done"
        displayMode="collapsed"
      />,
    );
    expect(screen.getByRole("button", { name: /reasoning/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("closes a finished block only when the reader closes it", () => {
    const { rerender } = render(
      <ReasoningPart
        text="First thought"
        state="streaming"
        displayMode="collapsed"
      />,
    );
    rerender(
      <ReasoningPart
        text="First thought, finished"
        state="done"
        displayMode="collapsed"
      />,
    );
    const toggle = screen.getByRole("button", { name: /reasoning/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText("First thought, finished"),
    ).not.toBeInTheDocument();
  });

  it("still resets when the display mode itself changes", () => {
    const { rerender } = render(
      <ReasoningPart text="Some reasoning" displayMode="collapsible" />,
    );
    expect(screen.getByRole("button", { name: /reasoning/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    rerender(<ReasoningPart text="Some reasoning" displayMode="collapsed" />);

    expect(screen.getByRole("button", { name: /reasoning/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
