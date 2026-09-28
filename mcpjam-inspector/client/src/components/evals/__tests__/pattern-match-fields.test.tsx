/**
 * The pattern-check editor shared by `toolInputMatches` and
 * `toolResultMatches`: a pattern list compiled live in re2js, the flags
 * written in their one canonical order, a path shown as the key and stored as
 * a one-key JSON Pointer, and optional fields that are omitted — never
 * written as defaults — because the predicate is the criterion's identity.
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

type Rule = Extract<
  Predicate,
  { type: "toolInputMatches" | "toolResultMatches" }
>;

type Options = {
  availableTools?: string[];
  toolArgSchemas?: ToolArgSchemas;
  toolOutputSchemas?: ToolArgSchemas;
};

function Harness({
  initial,
  onValue,
  onDraftValidityChange,
  options,
}: {
  initial: Predicate;
  onValue: (next: Rule) => void;
  onDraftValidityChange?: (hasInvalidDraft: boolean) => void;
  options: Options;
}) {
  const [value, setValue] = useState<Predicate[]>([initial]);
  return (
    <ChecksSection
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue(next[0] as Rule);
      }}
      availableTools={options.availableTools}
      toolArgSchemas={options.toolArgSchemas}
      toolOutputSchemas={options.toolOutputSchemas}
      onDraftValidityChange={onDraftValidityChange}
    />
  );
}

/** A blank input check with its tool filled in, so only the rest is at issue. */
function rule(over: Partial<Rule> = {}): Predicate {
  const blank = blankPredicate("toolInputMatches") as Rule;
  return { ...blank, toolName: "create_view", ...over } as Predicate;
}

/** A blank output check: no tool, which is every tool's results. */
function resultRule(over: Partial<Rule> = {}): Predicate {
  const blank = blankPredicate("toolResultMatches") as Rule;
  return { ...blank, ...over } as Predicate;
}

function setup(initial: Predicate = rule(), options: Options = {}) {
  const onValue = vi.fn<(next: Rule) => void>();
  const onDraftValidityChange = vi.fn<(invalid: boolean) => void>();
  render(
    <Harness
      initial={initial}
      onValue={onValue}
      onDraftValidityChange={onDraftValidityChange}
      options={options}
    />,
  );
  const last = () => onValue.mock.lastCall![0];
  return { onValue, onDraftValidityChange, last };
}

const pattern = (n: number) => screen.getByLabelText(`Pattern ${n}`);

describe("PatternMatchFields — shared by both kinds", () => {
  it("a fresh input check shows the one empty pattern without an error", () => {
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

  it("a fresh output check says the same of a result", () => {
    setup(resultRule());
    expect(pattern(1)).toHaveValue("");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByText(/A result passes only if it matches every pattern/),
    ).toHaveTextContent(
      "A result passes only if it matches every pattern. Use A|B for either.",
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
  });

  it("words the lookaround advice for a result on the output check", () => {
    const { last } = setup(resultRule());
    fireEvent.change(pattern(1), { target: { value: "(?=a)" } });
    expect(
      screen.getByText(
        "Lookahead and lookbehind aren't supported. To require two things in the same result, add another pattern.",
      ),
    ).toBeInTheDocument();
    expect(areAllChecksValid([last()])).toBe(false);
  });

  it("rejects a backreference", () => {
    const { last } = setup();
    fireEvent.change(pattern(1), { target: { value: "(a)\\1" } });
    expect(
      screen.getByText("Backreferences like \\1 aren't supported."),
    ).toBeInTheDocument();
    expect(areAllChecksValid([last()])).toBe(false);
  });

  it("an emptied pattern asks for one, and blocks save", () => {
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
      type: "toolInputMatches",
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
});

describe("PatternMatchFields — counting, per unit", () => {
  it("input: 0/0 means no call matches, not never called", async () => {
    const { last } = setup(rule({ patterns: ["secret"] }));
    const note = screen.getByText(/At least 0 and at most 0 means no call/);
    expect(note).toHaveTextContent(
      "At least 0 and at most 0 means no call matches. It does not mean the tool was never called.",
    );
    expect(note).toHaveTextContent(
      /Counts only calls that match every pattern, not all calls/,
    );
    expect(screen.getByText("Matching calls")).toBeInTheDocument();
    // Behind the disclosure until opened.
    expect(note).not.toBeVisible();
    await userEvent.click(screen.getByText("More options"));
    expect(note).toBeVisible();

    fireEvent.change(screen.getByLabelText("At least"), {
      target: { value: "0" },
    });
    // `min: 0` alone asserts nothing; the bounds rule says so beside the inputs.
    expect(screen.getByRole("alert")).toHaveTextContent(
      `"At least 0" needs an "at most" too: on its own it passes every transcript. Set "at most" to 0 for "no call matches".`,
    );
    expect(areAllChecksValid([last()])).toBe(false);

    fireEvent.change(screen.getByLabelText("At most"), {
      target: { value: "0" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(last()).toMatchObject({ min: 0, max: 0 });
    expect(areAllChecksValid([last()])).toBe(true);
  });

  it("output: 0/0 means no result matches, not that the tool returned nothing", async () => {
    const { last } = setup(resultRule({ patterns: ["secret"] }));
    const note = screen.getByText(/At least 0 and at most 0 means no result/);
    expect(note).toHaveTextContent(
      "At least 0 and at most 0 means no result matches. It does not mean the tool returned nothing.",
    );
    expect(note).toHaveTextContent(
      /Counts only results that match every pattern, not all results/,
    );
    expect(screen.getByText("Matching results")).toBeInTheDocument();
    expect(screen.queryByText("Matching calls")).toBeNull();

    await userEvent.click(screen.getByText("More options"));
    fireEvent.change(screen.getByLabelText("At least"), {
      target: { value: "0" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      `"At least 0" needs an "at most" too: on its own it passes every transcript. Set "at most" to 0 for "no result matches".`,
    );
    expect(areAllChecksValid([last()])).toBe(false);

    fireEvent.change(screen.getByLabelText("At most"), {
      target: { value: "0" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(last()).toEqual({
      type: "toolResultMatches",
      patterns: ["secret"],
      min: 0,
      max: 0,
    });
    expect(areAllChecksValid([last()])).toBe(true);
  });
});

describe("PatternMatchFields — the tool", () => {
  it("input requires a tool", () => {
    const { last } = setup(rule({ toolName: "", patterns: ["Idea"] }));
    expect(
      areAllChecksValid([rule({ toolName: "", patterns: ["Idea"] })]),
    ).toBe(false);
    fireEvent.blur(screen.getByLabelText("Tool"));
    expect(screen.getByText("Enter a tool name")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Tool"), {
      target: { value: "create_view" },
    });
    expect(last().toolName).toBe("create_view");
    expect(areAllChecksValid([last()])).toBe(true);
  });

  it("input offers no 'Any tool' choice", async () => {
    setup(rule({ patterns: ["Idea"] }), {
      availableTools: ["create_view", "search"],
    });
    await userEvent.click(screen.getByRole("combobox", { name: "Tool" }));
    expect(screen.queryByRole("option", { name: "Any tool" })).toBeNull();
    expect(
      screen.getByRole("option", { name: "create_view" }),
    ).toBeInTheDocument();
  });

  it("output reads any tool by default, and 'Any tool' omits toolName", async () => {
    const user = userEvent.setup();
    const { last } = setup(resultRule({ patterns: ["open"] }), {
      availableTools: ["create_view", "search"],
    });
    const tool = screen.getByRole("combobox", { name: "Tool" });
    expect(tool).toHaveTextContent("Any tool");

    await user.click(tool);
    await user.click(screen.getByRole("option", { name: "search" }));
    expect(last().toolName).toBe("search");
    expect(areAllChecksValid([last()])).toBe(true);

    await user.click(screen.getByRole("combobox", { name: "Tool" }));
    await user.click(screen.getByRole("option", { name: "Any tool" }));
    expect("toolName" in last()).toBe(false);
    expect(last()).toEqual({ type: "toolResultMatches", patterns: ["open"] });
    expect(areAllChecksValid([last()])).toBe(true);
  });

  it("output's free-text tool omits toolName when emptied", () => {
    const { last } = setup(resultRule({ patterns: ["open"] }));
    const tool = screen.getByLabelText("Tool");
    expect(tool).toHaveAttribute("placeholder", "Any tool");
    fireEvent.change(tool, { target: { value: "search" } });
    expect(last().toolName).toBe("search");
    fireEvent.change(tool, { target: { value: "" } });
    expect("toolName" in last()).toBe(false);
  });
});

describe("PatternMatchFields — the path", () => {
  it("reads the whole input by default and omits an emptied path", () => {
    const { last } = setup(rule({ patterns: ["Idea"] }));
    const argument = screen.getByLabelText("Argument");
    expect(argument).toHaveAttribute("placeholder", "Whole input");

    // The author types the key; the predicate stores its pointer.
    fireEvent.change(argument, { target: { value: "elements" } });
    expect(last().path).toBe("/elements");
    expect(argument).toHaveValue("elements");
    expect(areAllChecksValid([last()])).toBe(true);

    fireEvent.change(argument, { target: { value: "" } });
    expect("path" in last()).toBe(false);
  });

  it("escapes a typed key with / or ~ and shows it back as typed", () => {
    const { last } = setup(rule({ patterns: ["Idea"] }));
    const argument = screen.getByLabelText("Argument");
    fireEvent.change(argument, { target: { value: "a/b~c" } });
    expect(last().path).toBe("/a~1b~0c");
    expect(argument).toHaveValue("a/b~c");
    expect(areAllChecksValid([last()])).toBe(true);
  });

  it("names a key too long to store, counting each escape twice", () => {
    const { last } = setup(rule({ patterns: ["Idea"] }));
    const argument = screen.getByLabelText("Argument");
    // 256 characters is the most a key can have…
    fireEvent.change(argument, { target: { value: "k".repeat(256) } });
    expect(argument).not.toHaveAttribute("aria-invalid");
    expect(areAllChecksValid([last()])).toBe(true);
    // …and a "/" inside it is stored as two.
    fireEvent.change(argument, {
      target: { value: `/${"k".repeat(255)}` },
    });
    expect(last().path).toHaveLength(258);
    expect(argument).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText(
        'At most 256 characters; a "/" or "~" in the name counts as two.',
      ),
    ).toBeInTheDocument();
    expect(areAllChecksValid([last()])).toBe(false);
    // Not repeated as the schema's own row-level line.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a stored pointer that does not parse as stored, with why", () => {
    const { onValue } = setup(
      rule({ patterns: ["Idea"], path: "/elements/0" }),
      { toolArgSchemas: { create_view: { elements: {} } } },
    );
    // Free text, not the picker: no key decodes from it.
    const argument = screen.getByLabelText("Argument");
    expect(argument).toHaveValue("/elements/0");
    expect(argument).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText(/path must name exactly one top-level key/),
    ).toBeInTheDocument();
    expect(onValue).not.toHaveBeenCalled();
    expect(areAllChecksValid([rule({ path: "/elements/0" })])).toBe(false);
  });

  it("output: reads the whole output by default", () => {
    const { last } = setup(resultRule({ patterns: ["open"] }));
    const field = screen.getByLabelText("Field");
    expect(field).toHaveAttribute("placeholder", "Whole output");
    fireEvent.change(field, { target: { value: "status" } });
    expect(last().path).toBe("/status");
    fireEvent.change(field, { target: { value: "" } });
    expect("path" in last()).toBe(false);
  });

  it("offers the chosen tool's input keys, 'Whole input' first", async () => {
    const user = userEvent.setup();
    const { last } = setup(rule({ patterns: ["Idea"] }), {
      toolArgSchemas: {
        create_view: {
          elements: { type: "string" },
          "a/b": { type: "string" },
        },
      },
    });
    const picker = screen.getByRole("combobox", { name: "Argument" });
    expect(picker).toHaveTextContent("Whole input");

    await user.click(picker);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Whole input", "elements", "a/b"]);
    await user.click(screen.getByRole("option", { name: "elements" }));
    expect(last().path).toBe("/elements");
    // Shown as the key, never the pointer.
    expect(
      screen.getByRole("combobox", { name: "Argument" }),
    ).toHaveTextContent("elements");

    // A key with "/" in it is stored escaped.
    await user.click(screen.getByRole("combobox", { name: "Argument" }));
    await user.click(screen.getByRole("option", { name: "a/b" }));
    expect(last().path).toBe("/a~1b");
    expect(
      screen.getByRole("combobox", { name: "Argument" }),
    ).toHaveTextContent("a/b");
    expect(areAllChecksValid([last()])).toBe(true);

    // "Whole input" omits the path.
    await user.click(screen.getByRole("combobox", { name: "Argument" }));
    await user.click(screen.getByRole("option", { name: "Whole input" }));
    expect("path" in last()).toBe(false);
  });

  it("offers the chosen tool's declared output keys, 'Whole output' first", async () => {
    const user = userEvent.setup();
    const { last } = setup(
      resultRule({ toolName: "search", patterns: ["open"] }),
      {
        availableTools: ["search", "create_view"],
        toolOutputSchemas: { search: { status: {}, items: {} } },
      },
    );
    const picker = screen.getByRole("combobox", { name: "Field" });
    expect(picker).toHaveTextContent("Whole output");
    await user.click(picker);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Whole output",
      "status",
      "items",
    ]);
    await user.click(screen.getByRole("option", { name: "status" }));
    expect(last()).toEqual({
      type: "toolResultMatches",
      toolName: "search",
      patterns: ["open"],
      path: "/status",
    });
  });

  it("output: any tool, or a tool with no declared output schema, is free text", () => {
    setup(resultRule({ patterns: ["open"] }), {
      toolOutputSchemas: { search: { status: {} } },
    });
    // No tool chosen: there is no one schema to offer keys from.
    expect(screen.queryByRole("combobox", { name: "Field" })).toBeNull();
    expect(screen.getByLabelText("Field")).toHaveAttribute(
      "placeholder",
      "Whole output",
    );
  });

  it("drops a path the newly chosen tool does not declare", () => {
    const { last } = setup(
      rule({ toolName: "create_view", path: "/elements", patterns: ["a"] }),
      {
        toolArgSchemas: {
          create_view: { elements: {} },
          search: { query: {} },
        },
      },
    );
    fireEvent.change(screen.getByLabelText("Tool"), {
      target: { value: "search" },
    });
    expect(last().toolName).toBe("search");
    expect("path" in last()).toBe(false);
  });

  it("keeps the path when the output check switches to any tool", async () => {
    const user = userEvent.setup();
    const { last } = setup(
      resultRule({ toolName: "search", path: "/status", patterns: ["open"] }),
      {
        availableTools: ["search"],
        toolOutputSchemas: { search: { status: {} } },
      },
    );
    await user.click(screen.getByRole("combobox", { name: "Tool" }));
    await user.click(screen.getByRole("option", { name: "Any tool" }));
    expect(last()).toEqual({
      type: "toolResultMatches",
      path: "/status",
      patterns: ["open"],
    });
  });
});
