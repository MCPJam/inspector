import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "@/test";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import type { EvalJudgeConfig } from "../../types";
import { CustomJudgesSection } from "../custom-judges-section";
import { blankJudge, customizedCopy, judgeProblem } from "../custom-judges-model";
import { libraryModelRows } from "../library-suite-edits";

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (name: string) => name === "evaluator-library",
}));

const capabilities = {
  judges: {
    custom: {
      role: "advisory",
      templateVersion: 2,
      maxJudges: 5,
      maxPromptLength: 4000,
      variables: ["final_answer", "expected_output"],
      execution: "wired",
    },
  },
} as unknown as SuiteCapabilities;

const libraryJudge = {
  id: "answers-the-question-answers",
  label: "Answers what the user asked",
  prompt: "Did it answer? {{final_answer}}",
  output: { kind: "passfail" as const },
  evaluator: { id: "answers-the-question", version: 1 },
};

describe("CustomJudgesSection", () => {
  it("renders nothing where the backend cannot run judges", () => {
    const { container } = renderWithProviders(
      <CustomJudgesSection
        judgeConfig={undefined}
        onJudgeConfigChange={() => {}}
        capabilities={{} as SuiteCapabilities}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("writes a judge, refusing an unknown variable first", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <CustomJudgesSection
        judgeConfig={undefined}
        onJudgeConfigChange={onChange}
        capabilities={capabilities}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Judges you write" }),
    ).toHaveTextContent(
      "Each judge adds a charged model call per graded iteration.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Write a judge" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Cites the order number" },
    });
    fireEvent.change(screen.getByLabelText("Judge prompt"), {
      target: { value: "Is {{order_note}} in {{final_answer}}?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add judge" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "{{order_note}} isn't an available variable.",
    );
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Judge prompt"), {
      target: { value: "Does {{final_answer}} match {{expected_output}}?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add judge" }));
    const next = onChange.mock.calls[0][0] as EvalJudgeConfig;
    expect(next.customJudges?.judges).toEqual([
      {
        id: "judge",
        label: "Cites the order number",
        prompt: "Does {{final_answer}} match {{expected_output}}?",
        output: { kind: "passfail" },
      },
    ]);
  });

  it("lists customized copies with their library parent, not library judges", () => {
    const copy = customizedCopy(libraryJudge, [libraryJudge.id]);
    renderWithProviders(
      <CustomJudgesSection
        judgeConfig={{ customJudges: { judges: [libraryJudge, copy] } }}
        onJudgeConfigChange={() => {}}
        capabilities={capabilities}
      />,
    );
    const section = screen.getByRole("region", { name: "Judges you write" });
    expect(section).toHaveTextContent("Based on Answers the Question v1");
    expect(section.querySelectorAll("li")).toHaveLength(1);
  });

  it("reads the judge limit and prompt length from the backend's capability", () => {
    const custom = capabilities.judges?.custom;
    if (!custom) throw new Error("Expected the custom judge capability");
    const tight: SuiteCapabilities = {
      ...capabilities,
      judges: {
        ...capabilities.judges,
        custom: { ...custom, maxJudges: 1, maxPromptLength: 30 },
      },
    };
    const { unmount } = renderWithProviders(
      <CustomJudgesSection
        judgeConfig={{ customJudges: { judges: [libraryJudge] } }}
        onJudgeConfigChange={() => {}}
        capabilities={tight}
      />,
    );
    expect(screen.getByRole("button", { name: "Write a judge" })).toBeDisabled();
    unmount();
    renderWithProviders(
      <CustomJudgesSection
        judgeConfig={undefined}
        onJudgeConfigChange={() => {}}
        capabilities={tight}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Write a judge" }));
    expect(screen.getByText("0/30")).toBeInTheDocument();
  });
});

describe("Customize", () => {
  it("replaces a library judge with an editable copy that keeps its parent", () => {
    let config: EvalJudgeConfig | undefined = {
      customJudges: { judges: [libraryJudge] },
    };
    const rows = libraryModelRows(config, (next) => {
      config = next;
    });
    rows[0].onCustomize?.();
    const [copy] = config?.customJudges?.judges ?? [];
    expect(copy.evaluator).toBeUndefined();
    expect(copy.basedOn).toEqual({ id: "answers-the-question", version: 1 });
    expect(copy.prompt).toBe(libraryJudge.prompt);
    expect(copy.id).not.toBe(libraryJudge.id);
  });
});

describe("custom judge model", () => {
  it("makes unique ids the backend accepts", () => {
    expect(
      customizedCopy({ ...libraryJudge, label: "Cites the Order #" }, []).id,
    ).toBe("custom-cites-the-order");
    expect(blankJudge(["judge", "judge-2"]).id).toBe("judge-3");
  });

  it("asks for a variable and a passing score in range", () => {
    const base = { id: "j", label: "J", output: { kind: "passfail" as const } };
    expect(
      judgeProblem({ ...base, prompt: "Is it good?" }, [], [], 4000),
    ).toContain("at least one variable");
    expect(
      judgeProblem(
        {
          ...base,
          prompt: "{{final_answer}}",
          output: { kind: "score", threshold: 0 },
        },
        [],
        ["final_answer"],
        4000,
      ),
    ).toContain("passing score");
  });

  it("holds the prompt to the backend's length", () => {
    const judge = {
      id: "j",
      label: "J",
      prompt: "Judge {{final_answer}} carefully",
      output: { kind: "passfail" as const },
    };
    expect(judgeProblem(judge, [], ["final_answer"], 20)).toBe(
      "Keep the prompt under 20 characters.",
    );
    expect(judgeProblem(judge, [], ["final_answer"], 4000)).toBeUndefined();
  });

  it("refuses {{expected_outcome}}, as the backend does", () => {
    const judge = {
      id: "j",
      label: "J",
      prompt: "Compare with {{expected_outcome}}",
      output: { kind: "passfail" as const },
    };
    expect(judgeProblem(judge, [], ["expected_output"], 4000)).toBe(
      "{{expected_outcome}} isn't an available variable.",
    );
  });
});
