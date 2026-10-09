import { useState } from "react";
import {
  fireEvent,
  render,
  screen,
  cleanup,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Predicate } from "@/shared/eval-matching";
import {
  CheckRow,
  CheckDraftBoundary,
} from "@/components/evals/checks-section";
import { blankPredicate } from "@/shared/predicate-kinds";
import { EVAL_ADD_CATALOG } from "@/components/evals/eval-add-catalog";
import { buildCaseScorecard } from "../case-scorecard/case-scorecard-model";
import { PaperCheckRow } from "../case-spine/paper-check-row";
import { WidgetAssertionFields, defaultWidgetAssertion } from "@/components/evals/step-fields";
import { SpineCheckRow } from "../case-spine/spine-check-row";
import { PinnedToolCallFields } from "@/components/evals/pinned-tool-call-fields";
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));
afterEach(cleanup);

function Fields({
  initial,
  onChange = vi.fn(),
  onValidityChange = vi.fn(),
}: {
  initial: Predicate;
  onChange?: (p: Predicate) => void;
  onValidityChange?: (invalid: boolean) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <CheckDraftBoundary onValidityChange={onValidityChange}>
      <CheckRow
        embedded
        paper
        predicate={value}
        availableTools={["list_services", "get_service"]}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    </CheckDraftBoundary>
  );
}

it("keeps JSON edits local until valid, and reports the block to Save", () => {
  const onChange = vi.fn(),
    onValidityChange = vi.fn();
  render(
    <Fields
      initial={{
        type: "toolCalledWith",
        toolName: "list_services",
        args: { args: {} },
      }}
      onChange={onChange}
      onValidityChange={onValidityChange}
    />,
  );
  const args = screen.getByLabelText("Arguments");
  fireEvent.change(args, { target: { value: '{"service":' } });
  expect(args).toHaveValue('{"service":');
  expect(onChange).not.toHaveBeenCalled();
  expect(onValidityChange).toHaveBeenLastCalledWith(true);
  fireEvent.change(args, { target: { value: '{"service":"users"}' } });
  expect(onChange).toHaveBeenLastCalledWith({
    type: "toolCalledWith",
    toolName: "list_services",
    args: { args: { service: "users" } },
  });
  expect(onValidityChange).toHaveBeenLastCalledWith(false);
});

it("keeps exact matching and minimum call count behind the argument settings", async () => {
  const user = userEvent.setup(),
    onChange = vi.fn();
  render(
    <Fields
      initial={{
        type: "toolCalledWith",
        toolName: "list_services",
        args: { args: { service: "users" }, argumentMatching: "exact" },
        minCount: 2,
      }}
      onChange={onChange}
    />,
  );
  fireEvent.change(screen.getByLabelText("Arguments"), {
    target: { value: '{"service":"products"}' },
  });
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    args: { argumentMatching: "exact" },
    minCount: 2,
  });
  await user.click(screen.getByText("Argument settings"));
  expect(screen.getByLabelText("Argument matching")).toBeVisible();
  const settings = within(screen.getByText("Argument settings").parentElement!);
  expect(settings.getAllByRole("combobox")).toHaveLength(1);
  expect(settings.getAllByRole("spinbutton")).toHaveLength(1);
  expect(settings.queryByLabelText("Tool")).toBeNull();
  expect(settings.queryByLabelText("Arguments")).toBeNull();
  expect(settings.queryByText("Raw JSON")).toBeNull();
  expect(settings.queryByText("Add argument")).toBeNull();
  expect(screen.getAllByLabelText("Tool")).toHaveLength(1);
  expect(screen.getAllByLabelText("Arguments")).toHaveLength(1);

  const minimum = settings.getByLabelText("Minimum matching calls (optional)");
  expect(minimum).toHaveValue(2);
  fireEvent.change(minimum, { target: { value: "3" } });
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    toolName: "list_services",
    args: { args: { service: "products" }, argumentMatching: "exact" },
    minCount: 3,
  });

  for (const [option, mode] of [
    ["Partial (extras ok)", "partial"],
    ["Ignore (only tool name matters)", "ignore"],
    ["Exact (deep equal)", "exact"],
  ]) {
    await user.click(
      settings.getByRole("combobox", { name: "Argument matching" }),
    );
    await user.click(screen.getByRole("option", { name: option, exact: true }));
    expect(onChange.mock.lastCall?.[0]).toMatchObject({
      args: { args: { service: "products" }, argumentMatching: mode },
      minCount: 3,
    });
    if (mode === "ignore") {
      expect(screen.queryByLabelText("Arguments")).toBeNull();
    } else {
      expect(
        JSON.parse(
          (screen.getByLabelText("Arguments") as HTMLTextAreaElement).value,
        ),
      ).toEqual({ service: "products" });
    }
  }

  fireEvent.change(minimum, { target: { value: "" } });
  expect(onChange.mock.lastCall?.[0]).not.toHaveProperty("minCount");
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    args: { args: { service: "products" }, argumentMatching: "exact" },
  });
});

it.each([
  [{ type: "toolLatencyUnder", ms: 200 }, "ms", "ms"],
  [{ type: "toolResultSizeUnder", maxBytes: 200 }, "bytes", "maxBytes"],
  [{ type: "toolCallCountUnder", count: 4 }, "tool calls", "count"],
  [{ type: "tokenBudgetUnder", tokens: 200 }, "tokens", "tokens"],
  [{ type: "turnCountUnder", turns: 4 }, "user turns", "turns"],
] as const)("edits the small numeric field for %j", (initial, unit, field) => {
  const onChange = vi.fn();
  render(<Fields initial={initial} onChange={onChange} />);
  fireEvent.change(
    screen.getByRole("spinbutton", { name: `Strictly under (${unit})` }),
    { target: { value: "3" } },
  );
  expect(onChange.mock.lastCall?.[0]).toMatchObject({ [field]: 3 });
});

it("names both ordering pickers and preserves the other selected tool", async () => {
  const user = userEvent.setup(),
    onChange = vi.fn();
  render(
    <Fields
      initial={{
        type: "toolCalledBefore",
        toolName: "list_services",
        beforeToolName: "get_service",
      }}
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("combobox", { name: "First tool" }));
  await user.click(
    screen.getByRole("option", { name: "get_service", exact: true }),
  );
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    toolName: "get_service",
    beforeToolName: "get_service",
  });
  expect(
    screen.getByRole("combobox", { name: "Second tool" }),
  ).toHaveTextContent("get_service");
});

it("adds tools as removable chips, with no duplicate choices", async () => {
  const user = userEvent.setup(),
    onChange = vi.fn();
  render(
    <Fields
      initial={{ type: "onlyToolsCalled", toolNames: ["list_services"] }}
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Add a tool" }));
  expect(
    screen.queryByRole("button", { name: "list_services", exact: true }),
  ).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "get_service", exact: true }),
  );
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    toolNames: ["list_services", "get_service"],
  });
  await user.click(
    screen.getByRole("button", { name: "Remove list_services" }),
  );
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    toolNames: ["get_service"],
  });
});

it("edits visible text with View and Text fields", () => {
  const onChange = vi.fn();
  render(
    <WidgetAssertionFields
      paper
      value={{ kind: "textVisible", toolName: "list_services", text: "" }}
      availableTools={[{ name: "list_services" }]}
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("combobox", { name: "View" })).toHaveTextContent(
    "list_services",
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Text" }), {
    target: { value: "API Gateway" },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    kind: "textVisible",
    toolName: "list_services",
    text: "API Gateway",
  });
  expect(
    screen.getByRole("combobox", { name: "Assertion kind" }).closest("details"),
  ).not.toHaveAttribute("open");
});

it("uses the Add menu name for every predicate row", () => {
  const entries = EVAL_ADD_CATALOG.filter(
    (entry) => entry.choice.kind === "check",
  );
  for (const entry of entries) {
    if (entry.choice.kind !== "check") continue;
    const row = buildCaseScorecard({
      toolsChoice: "unset",
      steps: [{ id: "p", kind: "prompt", prompt: "Test" }],
      predicates: {
        mode: "replace",
        list: [blankPredicate(entry.choice.predicateKind)],
      },
    })
      .groups.flatMap((group) => group.rows)
      .find((r) => r.key === "case:0");
    expect(row?.kindLabel).toBe(entry.label);
  }
});

function RoleRow({
  advisoryOnly = false,
  onChange = vi.fn(),
}: {
  advisoryOnly?: boolean;
  onChange?: (next: Predicate) => void;
}) {
  const predicate: Predicate = advisoryOnly
    ? { type: "noEndingQuestion", role: "advisory" }
    : { type: "noToolErrors" };
  const row = buildCaseScorecard({
    toolsChoice: "unset",
    steps: [
      { id: "p", kind: "prompt", prompt: "Test" },
      { id: "c", kind: "assert", assertion: predicate },
    ],
  })
    .groups.flatMap((group) => group.rows)
    .find((r) => r.stepId === "c")!;
  return (
    <ul>
      <PaperCheckRow
        row={row}
        readOnly={false}
        checkPolicy
        onChangePredicate={onChange}
        onRemove={vi.fn()}
      />
    </ul>
  );
}
it("shows role consequences and changes only the check role", async () => {
  const user = userEvent.setup(),
    onChange = vi.fn();
  render(<RoleRow onChange={onChange} />);
  await user.click(
    screen.getByRole("button", { name: "Options for No tool errors" }),
  );
  expect(
    screen.getByRole("menuitemcheckbox", { name: /Required check/ }),
  ).toHaveAttribute("aria-checked", "true");
  await user.click(
    screen.getByRole("menuitemcheckbox", { name: /Advisory check/ }),
  );
  expect(onChange).toHaveBeenLastCalledWith({
    type: "noToolErrors",
    role: "advisory",
  });
});
it("disables Required for an advisory-only check", async () => {
  const user = userEvent.setup();
  render(<RoleRow advisoryOnly />);
  await user.click(
    screen.getByRole("button", {
      name: "Options for Final message does not end with a question",
    }),
  );
  expect(
    screen.getByRole("menuitemcheckbox", { name: /Required check/ }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByText("This check can only warn.")).toBeVisible();
});


const primaryFields: Record<Predicate["type"], readonly string[]> = {
  toolDescriptionsPresent: ["Minimum description length"],
  toolAnnotationsPresent: [],
  toolNamesUnique: [],
  toolInputSchemasWellFormed: [],
  toolOutputSchemasPresent: [],
  noDeprecatedToolExposed: [],
  toolCalledWith: ["Tool", "Arguments"],
  toolCalledAtLeastOnce: ["Tool"],
  toolNeverCalled: ["Tool"],
  onlyToolsCalled: [],
  firstToolWas: ["Tool"],
  toolCalledBefore: ["First tool", "Second tool"],
  noDestructiveToolCalled: [],
  noDeprecatedToolCalled: [],
  argumentsMatchToolSchema: [],
  toolInputMatches: ["Tool", "Pattern 1"],
  noRepeatedIdenticalCall: [],
  noToolErrors: [],
  toolLatencyUnder: ["Tool", "Strictly under (ms)"],
  toolResultSizeUnder: ["Tool", "Strictly under (bytes)"],
  toolCallCountUnder: ["Strictly under (tool calls)"],
  toolResultContains: ["Tool", "Text the result must contain"],
  toolResultMatches: ["Tool", "Pattern 1"],
  toolResultMatchesSchema: ["Tool", "Schema"],
  toolErrorNamesInput: [],
  fullPageHasContinuation: [],
  responseContains: ["Text"],
  responseCloseTo: ["Reference response"],
  responseMatches: ["Pattern"],
  finalAssistantMessageNonEmpty: [],
  widgetRendered: ["View"],
  widgetRenderLatencyUnder: ["Strictly under (ms)"],
  widgetNoConsoleErrors: ["View"],
  noEndingQuestion: [],
  tokenBudgetUnder: ["Strictly under (tokens)"],
  turnCountUnder: ["Strictly under (user turns)"],
};

it.each(EVAL_ADD_CATALOG.filter((entry) => entry.choice.kind === "check"))(
  "shows the Paper primary fields for $label",
  (entry) => {
    if (entry.choice.kind !== "check") throw new Error("Expected a check");
    render(<Fields initial={blankPredicate(entry.choice.predicateKind)} />);
    for (const label of primaryFields[entry.choice.predicateKind]) {
      expect(screen.getByLabelText(label)).toBeVisible();
    }
  },
);

it.each(
  EVAL_ADD_CATALOG.filter((entry) => entry.choice.kind === "widget-check"),
)("keeps the drawer heading and editable View for $label", (entry) => {
  if (entry.choice.kind !== "widget-check")
    throw new Error("Expected a view check");
  const assertion = defaultWidgetAssertion(
    entry.choice.widgetKind,
    "list_services",
  );
  const step = { id: "view-check", kind: "assert" as const, assertion };
  const row = buildCaseScorecard({
    toolsChoice: "unset",
    steps: [{ id: "prompt", kind: "prompt", prompt: "Test" }, step],
  })
    .groups.flatMap((group) => group.rows)
    .find((row) => row.stepId === step.id)!;
  const onChange = vi.fn();
  render(
    <ul>
      <SpineCheckRow
        step={step}
        row={row}
        availableTools={[]}
        readOnly={false}
        checkPolicy
        status={undefined}
        defaultOpen
        onChange={onChange}
        onRemove={vi.fn()}
      />
    </ul>,
  );
  expect(
    screen.getByRole("button", { name: `Edit ${entry.label}` }),
  ).toHaveTextContent(entry.label);
  fireEvent.change(screen.getByLabelText("View"), {
    target: { value: "get_service" },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    ...step,
    assertion: { ...assertion, toolName: "get_service" },
  });
});

it("keeps schema draft validation and the tool filter in the Paper detail row", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn(),
    onValidityChange = vi.fn();
  render(
    <Fields
      initial={{
        type: "toolResultMatchesSchema",
        toolName: "list_services",
        schema: { type: "object" },
      }}
      onChange={onChange}
      onValidityChange={onValidityChange}
    />,
  );
  fireEvent.change(screen.getByLabelText("Schema"), {
    target: { value: '{"type":' },
  });
  expect(onChange).not.toHaveBeenCalled();
  expect(onValidityChange).toHaveBeenLastCalledWith(true);
  fireEvent.change(screen.getByLabelText("Schema"), {
    target: { value: '{"type":"array"}' },
  });
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    schema: { type: "array" },
    toolName: "list_services",
  });
  expect(onValidityChange).toHaveBeenLastCalledWith(false);
  await user.click(screen.getByRole("combobox", { name: "Tool" }));
  await user.click(screen.getByRole("option", { name: "get_service" }));
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    schema: { type: "array" },
    toolName: "get_service",
  });
});

it("keeps the extra pattern controls working behind More options", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <Fields
      initial={{
        type: "toolInputMatches",
        toolName: "list_services",
        patterns: ["users"],
      }}
      onChange={onChange}
    />,
  );
  expect(screen.getByLabelText("Pattern 1")).toBeVisible();
  expect(screen.getByLabelText("Ignore case")).not.toBeVisible();
  await user.click(screen.getByText("More options"));
  await user.click(screen.getByLabelText("Ignore case"));
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    flags: "i",
    patterns: ["users"],
    toolName: "list_services",
  });
  fireEvent.change(screen.getByLabelText("At least"), {
    target: { value: "2" },
  });
  expect(onChange.mock.lastCall?.[0]).toMatchObject({ min: 2, flags: "i" });
});

it("keeps Call tool server, arguments, and timeout editing in the Paper layout", () => {
  const onChange = vi.fn();
  render(
    <PinnedToolCallFields
      paper
      seedKey="call"
      value={{
        serverName: "srv",
        toolName: "list_services",
        arguments: { service: "users" },
        renderTimeoutMs: 1000,
      }}
      suiteServers={[]}
      availableTools={[]}
      onChange={onChange}
    />,
  );
  expect(screen.getByLabelText("Server")).toHaveValue("srv");
  expect(screen.getByLabelText("Tool")).toHaveValue("list_services");
  fireEvent.change(screen.getByLabelText("Arguments"), {
    target: { value: '{"service":"products"}' },
  });
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    arguments: { service: "products" },
    renderTimeoutMs: 1000,
  });
  fireEvent.change(screen.getByLabelText("Render timeout ms (optional)"), {
    target: { value: "" },
  });
  expect(onChange.mock.lastCall?.[0]).not.toHaveProperty("renderTimeoutMs");
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    arguments: { service: "products" },
    serverName: "srv",
    toolName: "list_services",
  });
});


it("keeps Response close to settings and reference text when folded", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <Fields
      initial={{
        type: "responseCloseTo",
        reference: "API Gateway",
        maxDistance: 0.2,
        normalizeWhitespace: true,
      }}
      onChange={onChange}
    />,
  );
  fireEvent.change(screen.getByLabelText("Reference response"), {
    target: { value: "User Service" },
  });
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    reference: "User Service",
    maxDistance: 0.2,
    normalizeWhitespace: true,
  });
  await user.click(screen.getByText("Response settings"));
  fireEvent.change(screen.getByLabelText("Maximum text distance (0–1)"), {
    target: { value: "0.1" },
  });
  await user.click(screen.getByLabelText("Case sensitive"));
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    reference: "User Service",
    maxDistance: 0.1,
    normalizeWhitespace: true,
    caseSensitive: true,
  });
});


it("keeps annotation requirements behind Annotation settings", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <Fields
      initial={{ type: "toolAnnotationsPresent", require: ["readOnlyHint"] }}
      onChange={onChange}
    />,
  );
  expect(screen.getByLabelText("readOnlyHint")).not.toBeVisible();
  await user.click(screen.getByText("Annotation settings"));
  await user.click(screen.getByLabelText("destructiveHint"));
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    require: ["readOnlyHint", "destructiveHint"],
  });
});

it.each([
  "argumentsMatchToolSchema",
  "noRepeatedIdenticalCall",
  "toolErrorNamesInput",
  "fullPageHasContinuation",
] as const)(
  "keeps the optional tool filter for the sentence row %s",
  async (type) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Fields
        initial={{ type, toolName: "list_services" }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByText("Tool filter"));
    await user.click(
      screen.getByRole("combobox", { name: "Limit to tool (optional)" }),
    );
    await user.click(screen.getByRole("option", { name: "All tools" }));
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ type });
    expect(onChange.mock.lastCall?.[0]).not.toHaveProperty("toolName");
  },
);
