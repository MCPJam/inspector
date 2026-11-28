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
import {
  CUSTOM_JUDGES_OFF_COPY,
  RUBRIC_CHECKS_GOAL_OFF_COPY,
  RUBRIC_CHECKS_OFF_COPY,
} from "../library-pause";

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
      questionKinds: ["yesno", "choice", "score"],
      execution: "wired",
    },
    custom: {
      role: "advisory",
      variables: ["final_answer", "expected_output"],
      templateVersion: 2,
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
      questionKinds: ["choice", "score"],
    },
  },
};

function open(
  judgeConfig?: EvalJudgeConfig,
  support: SuiteCapabilities = capabilities,
  onAdd = vi.fn(),
) {
  renderWithProviders(
    <SuiteEvaluatorLibrary
      predicates={[]}
      authorableKinds={["finalAssistantMessageNonEmpty"]}
      judgeConfig={judgeConfig}
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
        id: "reports-tool-errors-reports-failures",
        label: "Reports Tool Errors",
        evaluator: { id: "reports-tool-errors", version: 1 },
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
    expect(
      screen.getByRole("spinbutton", { name: "Passing score" }),
    ).toHaveValue(0.7);
    fireEvent.click(screen.getByRole("radio", { name: "Pass or fail" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Checks citations" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Judge prompt" }), {
      target: { value: "Check citations in {{final_answer}}." },
    });
    click("Add judge");
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

  it("says each judge is charged, on the method card and in its editor", () => {
    open();
    const methods = within(
      screen.getByRole("region", { name: "Start from scratch" }),
    );
    expect(
      methods.getByRole("button", { name: "Judge prompt" }),
    ).toHaveAccessibleDescription(
      "Grade an iteration with a prompt. Each judge adds a charged model call per graded iteration.",
    );
    click("Judge prompt");
    expect(
      within(screen.getByRole("dialog", { name: "Judge prompt" })).getAllByText(
        /Each judge adds a charged model call per graded iteration\./,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("says when the suite will not run what a Method card adds", () => {
    open({
      rubricChecks: { enabled: false },
      customJudges: { enabled: false, judges: [] },
    });
    // Judges stay off until turned on, so the card says where.
    const judge = screen.getByRole("button", { name: "Judge prompt" });
    expect(judge).toBeDisabled();
    expect(judge).toHaveAccessibleDescription(CUSTOM_JUDGES_OFF_COPY);
    click("Decision questions");
    expect(screen.getByText(RUBRIC_CHECKS_OFF_COPY)).toBeVisible();
  });

  it("names the Rubric checks switch, not trials, while the goal judge is off", () => {
    open({ goalCompletion: { enabled: false } });
    click("Decision questions");
    expect(screen.getByText(RUBRIC_CHECKS_GOAL_OFF_COPY)).toBeVisible();
    expect(screen.queryByText(/trials/)).not.toBeInTheDocument();
  });

  it("keeps From library hidden until capabilities load", () => {
    renderWithProviders(
      <SuiteEvaluatorLibrary
        predicates={[]}
        authorableKinds={["finalAssistantMessageNonEmpty"]}
        judgeConfig={undefined}
        capabilities={null}
        onAdd={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "From library" }),
    ).not.toBeInTheDocument();
  });

  it("shows why the suite refused an add and keeps the draft", () => {
    const onAdd = vi.fn(() => "This suite already has that question.");
    open(undefined, capabilities, onAdd);
    click("Decision questions");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Cites evidence" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), {
      target: { value: "Does it cite evidence?" },
    });
    click("Add question");
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This suite already has that question.",
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Cites evidence",
    );
  });

  it("opens Question ID only for an ID error and keeps it open once fixed", () => {
    const { onAdd } = open();
    click("Decision questions");
    const id = screen.getByRole("textbox", { name: "Question ID" });
    click("Add question");
    expect(screen.getByRole("alert")).toHaveTextContent("A label is required");
    expect(id).not.toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Cites evidence" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), {
      target: { value: "Does it cite evidence?" },
    });
    fireEvent.change(id, { target: { value: "cites evidence" } });
    click("Add question");
    expect(screen.getByRole("alert")).toHaveTextContent(/^Id must be/);
    expect(id).toBeVisible();
    // Fixing the ID clears the error without hiding the field mid-edit.
    fireEvent.change(id, { target: { value: "cites-evidence" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(id).toBeVisible();
    click("Add question");
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [expect.objectContaining({ id: "cites-evidence" })],
      }),
    );
  });

  it("adds an authored question to the suite's judge config from the table", () => {
    const onJudgeConfigChange = vi.fn();
    renderWithProviders(
      <SuiteScorerTable
        scope={{ kind: "suite", predicates: [], onPredicatesChange: vi.fn() }}
        judgeConfig={{ goalCompletion: { threshold: 0.8 } }}
        onJudgeConfigChange={onJudgeConfigChange}
        onAddProvider={null}
        capabilities={capabilities}
        passOrFailHint=""
        judgeHint=""
      />,
    );
    click("From library");
    click("Decision questions");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Cites evidence" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), {
      target: { value: "Does it cite evidence?" },
    });
    click("Add question");
    expect(onJudgeConfigChange).toHaveBeenCalledWith({
      goalCompletion: { threshold: 0.8 },
      rubricChecks: {
        questions: [
          {
            id: "cites-evidence",
            kind: "yesno",
            label: "Cites evidence",
            instructions: "Does it cite evidence?",
            pass: { answer: "yes" },
          },
        ],
      },
    });
  });

  it("goes back to the library on Escape and asks before dropping a changed draft", () => {
    const { onAdd } = open();
    click("Judge prompt");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), {
      key: "Escape",
    });
    expect(
      screen.getByRole("dialog", { name: "Evaluator library" }),
    ).toBeInTheDocument();
    click("Judge prompt");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Half written" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), {
      key: "Escape",
    });
    const confirm = screen.getByRole("alertdialog", {
      name: "Discard this draft?",
    });
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Keep editing" }),
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Half written",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(
      within(
        screen.getByRole("alertdialog", { name: "Discard this draft?" }),
      ).getByRole("button", { name: "Discard" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("confirms a Method-card save went into the unsaved suite draft", () => {
    open();
    click("Judge prompt");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Checks citations" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Judge prompt" }), {
      target: { value: "Check citations in {{final_answer}}." },
    });
    click("Add judge");
    expect(
      screen.getByText(
        "Added to your unsaved changes. Save settings to keep it.",
      ),
    ).toBeVisible();
  });

  it("counts library questions toward the limit and says why the card is off", () => {
    const own = Array.from(
      { length: MAX_RUBRIC_CHECK_QUESTIONS - 1 },
      (_, i): RubricCheckQuestion => ({
        id: `q-${i}`,
        kind: "yesno",
        label: `Question ${i}`,
        instructions: "Is it true?",
        pass: { answer: "yes" },
      }),
    );
    const library = {
      ...own[0],
      id: "reports-tool-errors-reports-failures",
      evaluator: { id: "reports-tool-errors", version: 1 },
    };
    open({ rubricChecks: { questions: [library, ...own] } });
    const decision = screen.getByRole("button", { name: "Decision questions" });
    expect(decision).toBeDisabled();
    expect(decision).toHaveAccessibleDescription(/Remove a question/);
  });
});
