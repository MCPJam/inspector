import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, within } from "@/test";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { codeGradingGate } from "../../code-grading/code-grading-flags";
import type { CodeEvaluator } from "../code-evaluator-model";
import { CodeEvaluatorsSection } from "../code-evaluators-section";
import { librarySuiteEdits } from "../library-suite-edits";
import { SuiteEvaluatorLibrary } from "../suite-evaluator-library";
import type { SuiteCodeEvaluators } from "../suite-code-evaluators";

const flag = vi.hoisted(() => ({ library: true }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (name: string) =>
    name === "evaluator-library" ? flag.library : undefined,
}));
afterEach(() => {
  flag.library = true;
});

const off = { enabled: false };
const agreement = { reviews: 0, agreements: 0, rate: null, lowerBound: null };
const capabilities: SuiteCapabilities = {
  suiteId: "suite-1",
  organizationId: null,
  permissions: {
    "suite.view": true,
    "suite.edit": true,
    "suite.configure": true,
    "suite.delete": false,
    "suite.schedule": false,
    "suite.environments": false,
    "run.launch": true,
    "gate.waive": false,
    "judge.review": false,
  },
  features: {
    computers: off,
    environments: off,
    skills: off,
    "claude-code-harness": off,
    "codex-harness": off,
    "cursor-harness": off,
    scheduledEvals: off,
    "eval-code-evaluators": { enabled: true },
  },
  judge: { role: "advisory", hasRubric: false, agreement },
  revisionNumber: null,
};

const SAVED: CodeEvaluator = {
  id: "check_totals",
  name: "Invoice totals add up",
  fileName: "check_totals.py",
  script: "print('mine')\n",
  role: "required",
};

function codeEvaluators(
  patch: Partial<SuiteCodeEvaluators> = {},
): SuiteCodeEvaluators {
  return {
    evaluators: [],
    onChange: vi.fn(),
    gate: codeGradingGate(true, { enabled: true }),
    gradingMode: "enforce",
    scripts: undefined,
    ...patch,
  };
}

function openLibrary(code: SuiteCodeEvaluators, onAdd = vi.fn()) {
  renderWithProviders(
    <SuiteEvaluatorLibrary
      predicates={[]}
      authorableKinds={["finalAssistantMessageNonEmpty"]}
      judgeConfig={undefined}
      capabilities={capabilities}
      codeEvaluators={code}
      onAdd={onAdd}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "From library" }));
  return onAdd;
}

const codeCard = () => screen.queryByRole("button", { name: "Code" });

describe("the Code method in the evaluator library", () => {
  it("is the fourth card in Start from scratch", () => {
    openLibrary(codeEvaluators());
    const cards = within(
      screen.getByRole("region", { name: "Start from scratch" }),
    ).getAllByRole("button");
    expect(cards).toHaveLength(4);
    expect(cards[3]).toBe(codeCard());
    expect(codeCard()).toBeEnabled();
    expect(codeCard()).toHaveAccessibleDescription(
      "Grade an iteration with a script.",
    );
  });

  it("is left out while the eval-code-evaluators flag is off", () => {
    openLibrary(codeEvaluators({ gate: codeGradingGate(false, undefined) }));
    expect(codeCard()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assertions" })).toBeEnabled();
  });

  it("says why when the suite's capabilities refuse code evaluators", () => {
    openLibrary(
      codeEvaluators({
        gate: codeGradingGate(true, { enabled: false, reason: "flag_false" }),
      }),
    );
    expect(codeCard()).toBeDisabled();
    expect(codeCard()).toHaveAccessibleDescription(
      "Not enabled for this organization.",
    );
  });

  it("is off with the reason below dual_write", () => {
    openLibrary(codeEvaluators({ gradingMode: "off" }));
    expect(codeCard()).toBeDisabled();
    expect(codeCard()).toHaveAccessibleDescription(
      "Code evaluators need a suite on the current verdict policy with grading on. Use an assertion, decision question or judge prompt instead.",
    );
  });

  it("opens the editor and adds the evaluator to the suite draft", () => {
    const onAdd = openLibrary(codeEvaluators());
    fireEvent.click(codeCard()!);
    expect(
      screen.getByRole("dialog", { name: "Code" }),
    ).toHaveAccessibleDescription("Grade an iteration with a script.");
    const type = (name: string, value: string) =>
      fireEvent.change(screen.getByRole("textbox", { name }), {
        target: { value },
      });
    type("Name", "Calls each tool once");
    type("File name", "check_tool_calls.py");
    type("Script", "print(1)");
    fireEvent.click(screen.getByRole("button", { name: "Add evaluator" }));
    expect(onAdd).toHaveBeenCalledWith({
      checks: [],
      questions: [],
      judges: [],
      codeEvaluators: [
        {
          id: "check_tool_calls",
          name: "Calls each tool once",
          fileName: "check_tool_calls.py",
          script: "print(1)",
          role: "advisory",
        },
      ],
    });
    expect(
      screen.getByText(
        "Added to your unsaved changes. Save settings to keep it.",
      ),
    ).toBeInTheDocument();
  });

  it("offers Required only at the Enforce grading mode", () => {
    openLibrary(codeEvaluators({ gradingMode: "dual_write" }));
    fireEvent.click(codeCard()!);
    expect(
      within(screen.getByRole("group", { name: "Evaluator role" })).getByRole(
        "button",
        { name: "Required" },
      ),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "Required needs this suite's grading set to Enforce. Until it is, this evaluator can only be Advisory.",
      ),
    ).toBeInTheDocument();
  });
});

describe("librarySuiteEdits with code evaluators", () => {
  const scope = {
    kind: "suite" as const,
    predicates: [],
    onPredicatesChange: vi.fn(),
  };

  it("writes an added code evaluator after the suite's own", () => {
    const onChange = vi.fn();
    const edits = librarySuiteEdits(scope, undefined, vi.fn(), 5, {
      evaluators: [SAVED],
      onChange,
    });
    const added = { ...SAVED, id: "second", name: "Second" };
    expect(
      edits?.add({
        checks: [],
        questions: [],
        judges: [],
        codeEvaluators: [added],
      }),
    ).toBeUndefined();
    expect(onChange).toHaveBeenCalledWith([SAVED, added]);
  });

  it("refuses an ID the suite already uses, and an eleventh evaluator", () => {
    const onChange = vi.fn();
    const full = Array.from({ length: 10 }, (_, n) => ({
      ...SAVED,
      id: `check-${n}`,
    }));
    const edits = librarySuiteEdits(scope, undefined, vi.fn(), 5, {
      evaluators: full,
      onChange,
    });
    const addition = (evaluator: CodeEvaluator) => ({
      checks: [],
      questions: [],
      judges: [],
      codeEvaluators: [evaluator],
    });
    expect(edits?.add(addition({ ...SAVED, id: "check-3" }))).toBe(
      'Another code evaluator already uses the ID "check-3". Remove it to add this one.',
    );
    expect(edits?.add(addition({ ...SAVED, id: "new" }))).toBe(
      "Remove a code evaluator to add another. Each suite can have 10 code evaluators.",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves code evaluators alone when a preset adds assertions", () => {
    const onChange = vi.fn();
    const edits = librarySuiteEdits(scope, undefined, vi.fn(), 5, {
      evaluators: [SAVED],
      onChange,
    });
    edits?.add({ checks: [], questions: [], judges: [] });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("CodeEvaluatorsSection", () => {
  it("lists the suite's code evaluators with their file and role", () => {
    renderWithProviders(
      <CodeEvaluatorsSection
        codeEvaluators={codeEvaluators({
          evaluators: [
            SAVED,
            { ...SAVED, id: "b", name: "B", role: "advisory", threshold: 0.5 },
          ],
        })}
      />,
    );
    const section = screen.getByRole("region", { name: "Code evaluators" });
    expect(section).toHaveTextContent("Invoice totals add up");
    expect(section).toHaveTextContent("check_totals.py · Required");
    expect(section).toHaveTextContent(
      "check_totals.py · Advisory · passes at 0.5",
    );
  });

  it("edits an evaluator in place and saves it through the draft", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <CodeEvaluatorsSection
        codeEvaluators={codeEvaluators({ evaluators: [SAVED], onChange })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Edit Invoice totals add up" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Totals match the ledger" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onChange).toHaveBeenCalledWith([
      { ...SAVED, name: "Totals match the ledger" },
    ]);
  });

  it("removes an evaluator through the draft", () => {
    const onChange = vi.fn();
    const other = { ...SAVED, id: "other", name: "Other" };
    renderWithProviders(
      <CodeEvaluatorsSection
        codeEvaluators={codeEvaluators({
          evaluators: [SAVED, other],
          onChange,
        })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Invoice totals add up" }),
    );
    expect(onChange).toHaveBeenCalledWith([other]);
  });

  it("shows evaluators read-only with the flag off, and still removes them", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <CodeEvaluatorsSection
        codeEvaluators={codeEvaluators({
          evaluators: [SAVED],
          onChange,
          gate: codeGradingGate(false, undefined),
        })}
      />,
    );
    expect(
      screen.getByText(
        "Not enabled for this organization. These code evaluators still run, and you can remove them.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit Invoice totals add up" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Invoice totals add up" }),
    );
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("says why runs won't start when a Required one needs Enforce", () => {
    renderWithProviders(
      <CodeEvaluatorsSection
        codeEvaluators={codeEvaluators({
          evaluators: [SAVED],
          gradingMode: "dual_write",
        })}
      />,
    );
    expect(
      screen.getByText(
        "Runs of this suite won't start while a code evaluator is Required, which needs grading set to Enforce. Make it Advisory to run the suite.",
      ),
    ).toBeInTheDocument();
  });

  it("renders nothing for a suite without code evaluators", () => {
    const { container } = renderWithProviders(
      <CodeEvaluatorsSection codeEvaluators={codeEvaluators()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
