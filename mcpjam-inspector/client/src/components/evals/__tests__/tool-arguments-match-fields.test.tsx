/**
 * The `toolArgumentsMatch` editor: a pattern list compiled live in re2js, the
 * flags written in their one canonical order, and optional fields that are
 * omitted — never written as defaults — because the predicate is the
 * criterion's identity.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Predicate } from "@/shared/eval-matching";

vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));

import {
  areAllChecksValid,
  ChecksSection,
  type ToolArgSchemas,
} from "../checks-section";
import { blankPredicate } from "@/shared/predicate-kinds";

type Rule = Extract<Predicate, { type: "toolArgumentsMatch" }>;

function Harness({
  initial,
  onValue,
  onDraftValidityChange,
  toolArgSchemas,
}: {
  initial: Predicate;
  onValue: (next: Rule) => void;
  onDraftValidityChange?: (hasInvalidDraft: boolean) => void;
  toolArgSchemas?: ToolArgSchemas;
}) {
  const [value, setValue] = useState<Predicate[]>([initial]);
  return (
    <ChecksSection
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue(next[0] as Rule);
      }}
      toolArgSchemas={toolArgSchemas}
      onDraftValidityChange={onDraftValidityChange}
    />
  );
}

/** A blank check with its tool filled in, so only the patterns are at issue. */
function rule(over: Partial<Rule> = {}): Predicate {
  const blank = blankPredicate("toolArgumentsMatch") as Rule;
  return { ...blank, toolName: "create_view", ...over };
}

function setup(initial: Predicate = rule(), toolArgSchemas?: ToolArgSchemas) {
  const onValue = vi.fn<(next: Rule) => void>();
  const onDraftValidityChange = vi.fn<(invalid: boolean) => void>();
  render(
    <Harness
      initial={initial}
      onValue={onValue}
      onDraftValidityChange={onDraftValidityChange}
      toolArgSchemas={toolArgSchemas}
    />,
  );
  const last = () => onValue.mock.lastCall![0];
  return { onValue, onDraftValidityChange, last };
}

const pattern = (n: number) => screen.getByLabelText(`Pattern ${n}`);

describe("ToolArgumentsMatchFields", () => {
  it("a fresh check shows the one empty pattern without an error", () => {
    setup();
    expect(pattern(1)).toHaveValue("");
    expect(pattern(1)).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("Enter a pattern")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByText(/A call passes only if it matches every pattern/),
    ).toHaveTextContent(
      "A call passes only if it matches every pattern. Use A|B for either.",
    );
  });

  it("adds and removes patterns, keeping authored order", async () => {
    const { last } = setup();
    fireEvent.change(pattern(1), { target: { value: "Idea" } });
    await userEvent.click(screen.getByRole("button", { name: "Add pattern" }));
    fireEvent.change(pattern(2), { target: { value: "Build" } });
    await userEvent.click(screen.getByRole("button", { name: "Add pattern" }));
    fireEvent.change(pattern(3), { target: { value: "Ship" } });
    expect(last().patterns).toEqual(["Idea", "Build", "Ship"]);

    await userEvent.click(
      screen.getByRole("button", { name: "Remove pattern 2" }),
    );
    expect(last().patterns).toEqual(["Idea", "Ship"]);
    expect(pattern(2)).toHaveValue("Ship");

    await userEvent.click(
      screen.getByRole("button", { name: "Remove pattern 1" }),
    );
    expect(last().patterns).toEqual(["Ship"]);
    // At least one pattern, always.
    expect(
      screen.getByRole("button", { name: "Remove pattern 1" }),
    ).toBeDisabled();
  });

  it("stops adding at eight patterns", async () => {
    const { last } = setup(
      rule({ patterns: ["a", "b", "c", "d", "e", "f", "g"] }),
    );
    const add = screen.getByRole("button", { name: "Add pattern" });
    expect(add).toBeEnabled();
    await userEvent.click(add);
    expect(last().patterns).toHaveLength(8);
    expect(add).toBeDisabled();
  });

  it("an invalid pattern shows as typed and blocks save", () => {
    const { last, onDraftValidityChange } = setup();
    fireEvent.change(pattern(1), { target: { value: "(" } });

    expect(
      screen.getByText(/Not a valid pattern: missing closing \)/),
    ).toBeInTheDocument();
    expect(pattern(1)).toHaveAttribute("aria-invalid", "true");
    // The schema refuses it — the gate every Save uses — and the draft is
    // reported for callers that listen only to that.
    expect(areAllChecksValid([last()])).toBe(false);
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(true);
    // One message, on the row; not repeated as a row-level line.
    expect(screen.queryByText(/does not compile in re2js/)).toBeNull();

    fireEvent.change(pattern(1), { target: { value: "(Idea)" } });
    expect(screen.queryByText(/Not a valid pattern/)).toBeNull();
    expect(areAllChecksValid([last()])).toBe(true);
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("rejects a lookaround with a message that says what to do instead", () => {
    const { last } = setup();
    fireEvent.change(pattern(1), { target: { value: "(?=a)" } });
    expect(
      screen.getByText(
        "Lookahead and lookbehind aren't supported. To require two things in the same call, add another pattern.",
      ),
    ).toBeInTheDocument();
    expect(areAllChecksValid([last()])).toBe(false);

    fireEvent.change(pattern(1), { target: { value: "(?<!a)b" } });
    expect(screen.getByText(/Lookahead and lookbehind/)).toBeInTheDocument();

    fireEvent.change(pattern(1), { target: { value: "(a)\\1" } });
    expect(
      screen.getByText("Backreferences like \\1 aren't supported."),
    ).toBeInTheDocument();
  });

  it("an emptied pattern asks for one, and blocks save", async () => {
    const { last } = setup();
    fireEvent.change(pattern(1), { target: { value: "a" } });
    fireEvent.change(pattern(1), { target: { value: "" } });
    expect(screen.getByText("Enter a pattern")).toBeInTheDocument();
    expect(areAllChecksValid([last()])).toBe(false);
  });

  it("writes flags in canonical order, and drops the key when none is on", async () => {
    const { last } = setup(rule({ patterns: ["Idea"] }));
    await userEvent.click(screen.getByRole("switch", { name: "Ignore case" }));
    expect(last().flags).toBe("i");

    await userEvent.click(screen.getByText("More options"));
    await userEvent.click(
      screen.getByRole("switch", { name: "^ and $ match at line breaks" }),
    );
    expect(last().flags).toBe("im");
    await userEvent.click(
      screen.getByRole("switch", { name: ". matches line breaks" }),
    );
    expect(last().flags).toBe("ims");

    await userEvent.click(screen.getByRole("switch", { name: "Ignore case" }));
    expect(last().flags).toBe("ms");
    await userEvent.click(
      screen.getByRole("switch", { name: "^ and $ match at line breaks" }),
    );
    await userEvent.click(
      screen.getByRole("switch", { name: ". matches line breaks" }),
    );
    expect("flags" in last()).toBe(false);
    expect(areAllChecksValid([last()])).toBe(true);
  });

  it("leaves min and max unwritten until the author sets them", async () => {
    const { last } = setup();
    fireEvent.change(pattern(1), { target: { value: "Idea" } });
    expect(last()).toEqual({
      type: "toolArgumentsMatch",
      toolName: "create_view",
      patterns: ["Idea"],
    });

    await userEvent.click(screen.getByText("More options"));
    const atLeast = screen.getByLabelText("At least");
    const atMost = screen.getByLabelText("At most");
    expect(atLeast).toHaveValue(null);
    expect(atLeast).toHaveAttribute("placeholder", "1");

    fireEvent.change(atLeast, { target: { value: "2" } });
    fireEvent.change(atMost, { target: { value: "3" } });
    expect(last()).toMatchObject({ min: 2, max: 3 });

    fireEvent.change(atLeast, { target: { value: "" } });
    fireEvent.change(atMost, { target: { value: "" } });
    expect("min" in last()).toBe(false);
    expect("max" in last()).toBe(false);
  });

  it("explains under More options that 0/0 means no call matches, not never called", async () => {
    const { last } = setup(rule({ patterns: ["secret"] }));
    const note = screen.getByText(/At least 0 and at most 0 means no call/);
    expect(note).toHaveTextContent(
      "At least 0 and at most 0 means no call matches — not that the tool was never called.",
    );
    expect(note).toHaveTextContent(
      /Counts only calls that match every pattern/,
    );
    // Behind the disclosure until opened.
    expect(note).not.toBeVisible();
    await userEvent.click(screen.getByText("More options"));
    expect(note).toBeVisible();

    fireEvent.change(screen.getByLabelText("At least"), {
      target: { value: "0" },
    });
    // `min: 0` alone asserts nothing; the bounds rule says so beside the inputs.
    expect(screen.getByRole("alert")).toHaveTextContent(
      /"At least 0" needs an "at most" too/,
    );
    expect(areAllChecksValid([last()])).toBe(false);

    fireEvent.change(screen.getByLabelText("At most"), {
      target: { value: "0" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(last()).toMatchObject({ min: 0, max: 0 });
    expect(areAllChecksValid([last()])).toBe(true);
  });

  it("names a max below the default min", async () => {
    setup(rule({ patterns: ["a"] }));
    await userEvent.click(screen.getByText("More options"));
    fireEvent.change(screen.getByLabelText("At most"), {
      target: { value: "0" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      `"At most" can't be below "at least" (1 when left empty).`,
    );
  });

  it("opens More options for a saved check that uses them", () => {
    setup(rule({ patterns: ["a"], min: 0, max: 0 }));
    expect(screen.getByLabelText("At least")).toBeVisible();
    expect(screen.getByLabelText("At least")).toHaveValue(0);
  });

  it("reads the whole arguments by default and omits an emptied argument", () => {
    const { last } = setup(rule({ patterns: ["Idea"] }));
    const argument = screen.getByLabelText("Argument");
    expect(argument).toHaveAttribute("placeholder", "Whole arguments");

    fireEvent.change(argument, { target: { value: "elements" } });
    expect(last().argument).toBe("elements");
    fireEvent.change(argument, { target: { value: "" } });
    expect("argument" in last()).toBe(false);
  });

  it("offers the chosen tool's arguments when its schema is known", () => {
    setup(rule({ patterns: ["Idea"] }), {
      create_view: { elements: { type: "string" }, title: { type: "string" } },
    });
    expect(
      screen.getByRole("combobox", { name: "Argument" }),
    ).toHaveTextContent("Whole arguments");
  });

  it("drops an argument the newly chosen tool does not declare", () => {
    const { last } = setup(
      rule({ toolName: "create_view", argument: "elements", patterns: ["a"] }),
      { create_view: { elements: {} }, search: { query: {} } },
    );
    fireEvent.change(screen.getByLabelText("Tool"), {
      target: { value: "search" },
    });
    expect(last().toolName).toBe("search");
    expect("argument" in last()).toBe(false);
  });
});
