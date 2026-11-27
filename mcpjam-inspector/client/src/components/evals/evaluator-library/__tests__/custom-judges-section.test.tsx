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

const capabilities: Pick<SuiteCapabilities, "suiteId" | "judges"> = {
  // No suite id, so the editor renders without the preview's queries.
  suiteId: "",
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
};

const libraryJudge = {
  id: "answers-the-question-answers",
  label: "Answers what the user asked",
  prompt: "Did it answer? {{final_answer}}",
  output: { kind: "passfail" as const },
  evaluator: { id: "answers-the-question", version: 1 },
};

const written = {
  id: "judge",
  label: "Cites the order number",
  prompt: "Is the order number in {{final_answer}}?",
  output: { kind: "passfail" as const },
};

describe("CustomJudgesSection", () => {
  it("renders nothing where the backend cannot run judges", () => {
    const { container } = renderWithProviders(
      <CustomJudgesSection
        judgeConfig={undefined}
        onJudgeConfigChange={() => {}}
        capabilities={{ suiteId: "", judges: {} }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("edits a written judge, refusing an unknown variable first", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <CustomJudgesSection
        judgeConfig={{ customJudges: { judges: [written] } }}
        onJudgeConfigChange={onChange}
        capabilities={capabilities}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Judges you write" }),
    ).toHaveTextContent(
      "Each judge adds a charged model call per graded iteration.",
    );
    // The library's Judge prompt card is the one way to add a judge.
    expect(screen.queryByRole("button", { name: "Write a judge" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: `Edit ${written.label}` }),
    );
    fireEvent.change(screen.getByLabelText("Judge prompt"), {
      target: { value: "Is {{order_note}} in {{final_answer}}?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save judge" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "{{order_note}} isn't an available variable.",
    );
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Judge prompt"), {
      target: { value: "Does {{final_answer}} match {{expected_output}}?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save judge" }));
    const next = onChange.mock.calls[0][0] as EvalJudgeConfig;
    expect(next.customJudges?.judges).toEqual([
      {
        ...written,
        prompt: "Does {{final_answer}} match {{expected_output}}?",
      },
    ]);
  });

  it("renders nothing until the suite has written a judge", () => {
    const { container } = renderWithProviders(
      <CustomJudgesSection
        judgeConfig={{ customJudges: { judges: [libraryJudge] } }}
        onJudgeConfigChange={() => {}}
        capabilities={capabilities}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("turns custom judges back on when the suite has them off", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <CustomJudgesSection
        judgeConfig={{
          goalCompletion: { threshold: 0.8 },
          customJudges: { enabled: false, judges: [libraryJudge] },
        }}
        onJudgeConfigChange={onChange}
        capabilities={capabilities}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Judges you write" }),
    ).toHaveTextContent(
      "Custom judges are off for this suite, so they will not run. Turn them on under Judges you write.",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on custom judges" }),
    );
    expect(onChange).toHaveBeenCalledWith({
      goalCompletion: { threshold: 0.8 },
      customJudges: { enabled: true, judges: [libraryJudge] },
    });
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

  it("reads the prompt length from the backend's capability", () => {
    const custom = capabilities.judges?.custom;
    if (!custom) throw new Error("Expected the custom judge capability");
    renderWithProviders(
      <CustomJudgesSection
        judgeConfig={{ customJudges: { judges: [written] } }}
        onJudgeConfigChange={() => {}}
        capabilities={{
          ...capabilities,
          judges: { custom: { ...custom, maxPromptLength: 50 } },
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: `Edit ${written.label}` }),
    );
    expect(screen.getByText(`${written.prompt.length}/50`)).toBeInTheDocument();
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
