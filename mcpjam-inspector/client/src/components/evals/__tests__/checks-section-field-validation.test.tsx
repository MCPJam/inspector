/**
 * A freshly added check fails the SDK schema before anyone has typed: eight
 * kinds start with a required string empty. These cases pin that the failure
 * is SHOWN only once the field is touched or the caller asks for everything
 * (`showAllErrors`), with copy that names the field, not Zod's wording.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Predicate } from "@mcpjam/sdk/browser";

vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));

import { ChecksSection } from "../checks-section";

function Harness({
  initial,
  availableTools,
  showAllErrors,
}: {
  initial: Predicate[];
  availableTools?: string[];
  showAllErrors?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ChecksSection
      value={value}
      onChange={setValue}
      availableTools={availableTools}
      showAllErrors={showAllErrors}
    />
  );
}

const blankToolCalledWith = (): Predicate =>
  ({ type: "toolCalledWith", toolName: "", args: { args: {} } }) as Predicate;

/** The card around a row, found from any control inside it. */
function rowCardOf(control: HTMLElement): HTMLElement {
  return control.closest("li")!.firstElementChild as HTMLElement;
}

const ZOD_WORDING = /Too small|Invalid input/;

describe("CheckRow untouched state", () => {
  it("a fresh check shows no error and no red border", () => {
    render(<Harness initial={[blankToolCalledWith()]} />);
    const tool = screen.getByLabelText("Tool");
    expect(tool).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("Enter a tool name")).toBeNull();
    expect(screen.queryByText(ZOD_WORDING)).toBeNull();
    expect(rowCardOf(tool).className).not.toContain("border-destructive");
  });

  it("blurring the empty field shows the field's own message", () => {
    render(<Harness initial={[blankToolCalledWith()]} />);
    const tool = screen.getByLabelText("Tool");
    fireEvent.blur(tool);

    const message = screen.getByText("Enter a tool name");
    expect(tool).toHaveAttribute("aria-invalid", "true");
    expect(tool).toHaveAttribute("aria-describedby", message.id);
    expect(rowCardOf(tool).className).toContain("border-destructive");
    expect(screen.queryByText(ZOD_WORDING)).toBeNull();
  });

  it("typing a value clears the message and the border", () => {
    render(<Harness initial={[blankToolCalledWith()]} />);
    const tool = screen.getByLabelText("Tool");
    fireEvent.blur(tool);
    expect(screen.getByText("Enter a tool name")).toBeInTheDocument();

    fireEvent.change(tool, { target: { value: "search" } });
    expect(screen.queryByText("Enter a tool name")).toBeNull();
    expect(tool).not.toHaveAttribute("aria-invalid");
    expect(rowCardOf(tool).className).not.toContain("border-destructive");
  });

  it("clearing a value the user typed brings the message back", () => {
    render(<Harness initial={[blankToolCalledWith()]} />);
    const tool = screen.getByLabelText("Tool");
    fireEvent.change(tool, { target: { value: "s" } });
    fireEvent.change(tool, { target: { value: "" } });
    expect(screen.getByText("Enter a tool name")).toBeInTheDocument();
  });

  it("showAllErrors reveals every incomplete row at once", () => {
    render(
      <Harness
        initial={[
          blankToolCalledWith(),
          { type: "responseContains", needle: "" } as Predicate,
          { type: "noToolErrors" } as Predicate,
        ]}
        showAllErrors
      />,
    );
    expect(screen.getByText("Enter a tool name")).toBeInTheDocument();
    expect(screen.getByText("Enter the text to look for")).toBeInTheDocument();
    // A kind that is valid when blank has nothing to reveal.
    const cards = screen.getAllByRole("listitem");
    expect(cards).toHaveLength(3);
    expect(
      (cards[2]!.firstElementChild as HTMLElement).className,
    ).not.toContain("border-destructive");
  });

  it("uses dropdown copy when the tool list is known", () => {
    render(
      <Harness
        initial={[blankToolCalledWith()]}
        availableTools={["search", "fetch"]}
        showAllErrors
      />,
    );
    expect(screen.getByText("Pick a tool")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Tool" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("reports the ordering rule's two fields separately", () => {
    render(
      <Harness
        initial={[
          {
            type: "toolCalledBefore",
            toolName: "",
            beforeToolName: "",
          } as Predicate,
        ]}
      />,
    );
    const first = screen.getByLabelText("Must be called first");
    const second = screen.getByLabelText("Before this tool");

    fireEvent.blur(first);
    expect(screen.getAllByText("Enter a tool name")).toHaveLength(1);
    expect(first).toHaveAttribute("aria-invalid", "true");
    expect(second).not.toHaveAttribute("aria-invalid");

    fireEvent.change(first, { target: { value: "login" } });
    fireEvent.blur(second);
    expect(screen.getAllByText("Enter a tool name")).toHaveLength(1);
    expect(second).toHaveAttribute("aria-invalid", "true");
  });

  it("an invalid regex shows as typed; an empty pattern waits for a touch", () => {
    render(
      <Harness
        initial={[{ type: "responseMatches", pattern: "" } as Predicate]}
      />,
    );
    const pattern = screen.getByLabelText(/Regex pattern/);
    expect(screen.queryByText("Enter a pattern")).toBeNull();

    fireEvent.change(pattern, { target: { value: "(" } });
    expect(screen.getByText(/Invalid regular expression/)).toBeInTheDocument();

    fireEvent.change(pattern, { target: { value: "" } });
    expect(screen.getByText("Enter a pattern")).toBeInTheDocument();

    fireEvent.change(pattern, { target: { value: "^ok$" } });
    expect(screen.queryByText("Enter a pattern")).toBeNull();
    expect(screen.queryByText(/Invalid regular expression/)).toBeNull();
  });

  it("covers the tool-result text field", () => {
    render(
      <Harness
        initial={[{ type: "toolResultContains", needle: "" } as Predicate]}
      />,
    );
    const needle = screen.getByLabelText("Text the result must contain");
    fireEvent.blur(needle);
    expect(
      screen.getByText("Enter the text the result must contain"),
    ).toBeInTheDocument();
  });

  it("deleting a touched row does not hand its touched state to the row below", async () => {
    render(
      <Harness initial={[blankToolCalledWith(), blankToolCalledWith()]} />,
    );
    const [first] = screen.getAllByLabelText("Tool");
    fireEvent.blur(first!);
    expect(screen.getAllByText("Enter a tool name")).toHaveLength(1);

    await act(async () => {
      await userEvent.click(
        screen.getAllByRole("button", { name: "Remove check" })[0]!,
      );
    });

    // The surviving row was never touched and must still look neutral.
    expect(screen.getAllByLabelText("Tool")).toHaveLength(1);
    expect(screen.queryByText("Enter a tool name")).toBeNull();
    expect(rowCardOf(screen.getByLabelText("Tool")).className).not.toContain(
      "border-destructive",
    );
  });

  it("a saved check with a legacy empty field stays neutral until touched", () => {
    render(
      <Harness
        initial={[{ type: "toolCalledAtLeastOnce", toolName: "" } as Predicate]}
      />,
    );
    expect(screen.queryByText("Enter a tool name")).toBeNull();
    fireEvent.blur(screen.getByLabelText("Tool"));
    expect(screen.getByText("Enter a tool name")).toBeInTheDocument();
  });
});
