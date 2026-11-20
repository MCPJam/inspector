import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "@/test";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import type { EvalJudgeConfig } from "../../types";
import { CustomJudgesSection } from "../custom-judges-section";
import { customizedCopy, judgeIdFor, judgeProblem } from "../custom-judges-model";
import { libraryModelRows } from "../library-suite-edits";

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (name: string) => name === "evaluator-library",
}));

const capabilities = {
  judges: {
    custom: {
      role: "advisory",
      templateVersion: 1,
      maxJudges: 5,
      maxPromptLength: 4000,
      variables: [],
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
    fireEvent.click(screen.getByRole("button", { name: "Write a judge" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Cites the order number" },
    });
    fireEvent.change(screen.getByLabelText("Judge prompt"), {
      target: { value: "Is {{order_note}} in {{final_answer}}?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save judge" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "{{order_note}} isn't an available variable.",
    );
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Judge prompt"), {
      target: { value: "Does {{final_answer}} state the order number?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save judge" }));
    const next = onChange.mock.calls[0][0] as EvalJudgeConfig;
    expect(next.customJudges?.judges).toEqual([
      {
        id: "judge",
        label: "Cites the order number",
        prompt: "Does {{final_answer}} state the order number?",
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
    expect(judgeIdFor("Cites the Order #", [])).toBe("cites-the-order");
    expect(judgeIdFor("Judge", ["judge", "judge-2"])).toBe("judge-3");
  });

  it("asks for a variable and a passing score in range", () => {
    const base = { id: "j", label: "J", output: { kind: "passfail" as const } };
    expect(judgeProblem({ ...base, prompt: "Is it good?" }, [])).toContain(
      "at least one variable",
    );
    expect(
      judgeProblem(
        {
          ...base,
          prompt: "{{final_answer}}",
          output: { kind: "score", threshold: 0 },
        },
        [],
      ),
    ).toContain("passing score");
  });
});
