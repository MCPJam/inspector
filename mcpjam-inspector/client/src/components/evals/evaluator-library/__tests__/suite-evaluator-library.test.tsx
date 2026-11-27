import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, within } from "@/test";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import {
  MAX_RUBRIC_CHECK_QUESTIONS,
  type RubricCheckQuestion,
} from "@/components/shared/session-quality/judge-config";
import { SuiteEvaluatorLibrary } from "../suite-evaluator-library";
import { SuiteScorerTable } from "../../suite-scorer-table";
import type { EvalJudgeConfig } from "../../types";

vi.mock("@/components/chat-v2/chat-input/model/provider-logo", () => ({
  ProviderLogo: () => <span aria-hidden="true" />,
}));

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (name: string) =>
    name === "evaluator-library" && flag.on,
}));
afterEach(() => {
  flag.on = true;
});

const agreement = { reviews: 0, agreements: 0, rate: null, kappa: null };
const gate = { enabled: false };
const capabilities = {
  suiteId: "",
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
    computers: gate,
    environments: gate,
    skills: gate,
    "claude-code-harness": gate,
    "codex-harness": gate,
    "cursor-harness": gate,
    scheduledEvals: gate,
  },
  judge: { role: "advisory", hasRubric: false, agreement },
  judges: {
    goalCompletion: {
      role: "advisory",
      calibration: agreement,
      template: { version: 1, hash: "goal" },
      execution: "wired",
    },
    groundedness: {
      role: "advisory",
      calibration: "unavailable",
      template: null,
      execution: "not_wired",
    },
    rubricChecks: {
      role: "advisory",
      calibration: "unavailable",
      template: { version: 2, hash: "rubric" },
      execution: "wired",
    },
    custom: {
      role: "advisory",
      variables: ["final_answer", "expected_output"],
      templateVersion: 1,
      maxJudges: 5,
      maxPromptLength: 10_000,
      execution: "wired",
    },
  },
  revisionNumber: null,
} satisfies SuiteCapabilities;

const v1Capabilities: SuiteCapabilities = {
  ...capabilities,
  judges: {
    ...capabilities.judges,
    rubricChecks: {
      ...capabilities.judges.rubricChecks,
      template: { version: 1, hash: "rubric-v1" },
    },
  },
};

function open(
  judgeConfig?: EvalJudgeConfig,
  support: SuiteCapabilities = capabilities,
) {
  const onAdd = vi.fn();
  renderWithProviders(
    <SuiteEvaluatorLibrary
      predicates={[]}
      authorableKinds={["finalAssistantMessageNonEmpty"]}
      judgeConfig={judgeConfig}
      canEditJudgeConfig
      capabilities={support}
      onAdd={onAdd}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "From library" }));
  return { onAdd };
}

function click(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("starting an evaluator from scratch", () => {
  it("offers Choice and Score on rubric v1", () => {
    open(undefined, v1Capabilities);
    click("Decision questions");
    const types = within(screen.getByRole("group", { name: "Question type" }));
    expect(types.getByRole("button", { name: "Choice" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(types.getByRole("button", { name: "Score" })).toBeEnabled();
    expect(types.queryByRole("button", { name: "Yes/no" })).toBeNull();
  });

  it("keeps authored question controls behind the library flag", () => {
    flag.on = false;
    renderWithProviders(
      <SuiteScorerTable
        scope={{ kind: "suite", predicates: [], onPredicatesChange: vi.fn() }}
        judgeConfig={{
          rubricChecks: {
            questions: [
              {
                id: "citation",
                kind: "yesno",
                label: "Citation requested",
                instructions: "Did the answer give a citation?",
                pass: { answer: "yes" },
              },
            ],
          },
        }}
        onJudgeConfigChange={vi.fn()}
        onAddProvider={null}
        capabilities={capabilities}
        passOrFailHint=""
        judgeHint=""
      />,
    );
    expect(
      screen.queryByRole("region", { name: "Decision questions" }),
    ).not.toBeInTheDocument();
  });

  it.each([capabilities, v1Capabilities])(
    "edits saved Choice questions without replacing neighboring questions",
    (support) => {
      const onJudgeConfigChange = vi.fn();
      const authored = {
        id: "citation",
        kind: "choice",
        label: "Citation requested",
        instructions: "Did the answer give a citation?",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
        pass: { anyOf: ["yes"] },
      } satisfies RubricCheckQuestion;
      const preset = {
        ...authored,
        id: "answer-grounded-in-results-grounded",
        label: "Answer Grounded in Results",
        evaluator: { id: "answer-grounded-in-results", version: 1 },
      };
      renderWithProviders(
        <SuiteScorerTable
          scope={{ kind: "suite", predicates: [], onPredicatesChange: vi.fn() }}
          judgeConfig={{ rubricChecks: { questions: [authored, preset] } }}
          onJudgeConfigChange={onJudgeConfigChange}
          onAddProvider={null}
          capabilities={support}
          passOrFailHint=""
          judgeHint=""
        />,
      );
      const section = within(
        screen.getByRole("region", { name: "Decision questions" }),
      );
      expect(section.getByText(authored.label)).toBeVisible();
      expect(section.queryByText(preset.label)).not.toBeInTheDocument();
      expect(section.getAllByRole("button", { name: /Edit/ })).toHaveLength(1);
      fireEvent.click(
        section.getByRole("button", { name: "Edit Citation requested" }),
      );
      fireEvent.change(
        section.getByRole("textbox", { name: "Question 1 text" }),
        {
          target: { value: "Did the answer cite a tool result?" },
        },
      );
      fireEvent.click(section.getByRole("button", { name: "Save question" }));
      expect(onJudgeConfigChange).toHaveBeenCalledWith({
        rubricChecks: {
          questions: [
            { ...authored, instructions: "Did the answer cite a tool result?" },
            preset,
          ],
        },
      });
    },
  );
  it("keeps Method cards on the unfiltered All evaluators view", () => {
    open();
    click("Final answer");
    expect(
      screen.queryByRole("region", { name: "Start from scratch" }),
    ).not.toBeInTheDocument();
    click("All evaluators");
    const search = screen.getByRole("searchbox", { name: "Search presets" });
    fireEvent.change(search, { target: { value: "answer" } });
    expect(
      screen.queryByRole("region", { name: "Start from scratch" }),
    ).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    expect(
      screen.getByRole("region", { name: "Start from scratch" }),
    ).toBeVisible();
  });
  it("renders three described actions and saves an untagged assertion", async () => {
    const { onAdd } = open();
    const methods = within(
      screen.getByRole("region", { name: "Start from scratch" }),
    );
    expect(methods.getAllByRole("button")).toHaveLength(3);
    expect(
      methods.getByRole("button", { name: "Assertions" }),
    ).toHaveAccessibleDescription("Combine built-in checks.");
    click("Assertions");
    expect(
      screen.getByRole("dialog", { name: "Assertions" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveTextContent(
      "Choose an assertion type",
    );
    expect(
      screen.getByRole("button", { name: "Add assertions" }),
    ).toBeDisabled();

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("option", { name: "Final message non-empty" }),
    );
    expect(onAdd).not.toHaveBeenCalled();
    click("Add assertions");
    expect(onAdd).toHaveBeenCalledWith({
      checks: [{ type: "finalAssistantMessageNonEmpty" }],
      questions: [],
      judges: [],
    });
    expect(
      screen.getByRole("dialog", { name: "Evaluator library" }),
    ).toBeInTheDocument();
  });

  it("validates and adds a decision question with its selected passing answer", () => {
    const { onAdd } = open();
    click("Decision questions");
    click("Add question");
    expect(screen.getByRole("alert")).toHaveTextContent("A label is required");
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Cites evidence" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), {
      target: { value: "Is evidence missing?" },
    });
    click("Choice");
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue(
      "Is evidence missing?",
    );
    click("Yes/no");
    click("No");
    click("Add question");
    expect(onAdd).toHaveBeenCalledWith({
      checks: [],
      judges: [],
      questions: [
        {
          id: "cites-evidence",
          kind: "yesno",
          label: "Cites evidence",
          instructions: "Is evidence missing?",
          pass: { answer: "no" },
        },
      ],
    });
  });

  it("uses the existing prompt editor and discards a canceled draft", () => {
    const { onAdd } = open();
    click("Judge prompt");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Discard me" },
    });
    click("Cancel");
    expect(onAdd).not.toHaveBeenCalled();
    click("Judge prompt");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
    expect(
      screen.queryByRole("spinbutton", { name: "Passing score" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Score from 0 to 1" }));
    expect(screen.getByRole("spinbutton", { name: "Passing score" })).toHaveValue(
      0.7,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Pass or fail" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Checks citations" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Judge prompt" }), {
      target: { value: "Check citations in {{final_answer}}." },
    });
    click("Save judge");
    expect(onAdd).toHaveBeenCalledWith({
      checks: [],
      questions: [],
      judges: [
        {
          id: "judge",
          label: "Checks citations",
          prompt: "Check citations in {{final_answer}}.",
          output: { kind: "passfail" },
        },
      ],
    });
  });

  it("explains why a method has reached its suite limit", () => {
    open({
      rubricChecks: {
        questions: Array.from(
          { length: MAX_RUBRIC_CHECK_QUESTIONS },
          (_, i) => ({
            id: `q-${i}`,
            kind: "yesno",
            label: `Question ${i}`,
            instructions: "Is it true?",
            pass: { answer: "yes" },
          }),
        ),
      },
    });
    const decision = screen.getByRole("button", { name: "Decision questions" });
    expect(decision).toBeDisabled();
    expect(decision).toHaveAccessibleDescription(/Remove a question/);
  });
});
