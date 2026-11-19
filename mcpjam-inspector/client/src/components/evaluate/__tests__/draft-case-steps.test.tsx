import { useState } from "react";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderWithProviders, screen, userEvent } from "@/test";
import type { CaseSaveForm } from "@/components/evals/case-save-payload";
import type { EvalSuite } from "@/components/evals/types";
import {
  editGeneratedDraft,
  evalSuiteKey,
  registerEvalSuite,
  useEvalGeneration,
} from "@/lib/mcpjam-agent/eval-workspace";
import type { TestStep } from "@/shared/steps";
import {
  DescribeCaseSteps,
  useGeneratedDraftSteps,
} from "../case-steps/draft-case-steps";
import type { ToolsChoice } from "../simple-case/simple-case-model";
import { EvalGeneratedDrafts } from "../eval-generated-drafts";

const suite = {
  _id: "suite",
  name: "Excalidraw quickstart",
  defaultPredicates: [],
  environment: { servers: ["excalidraw"] },
} as unknown as EvalSuite;

vi.mock("convex/react", () => ({
  useQuery: () => suite,
  useMutation: () => vi.fn(),
}));
vi.mock("@/hooks/use-suite-harness-targets", () => ({
  useSuiteHarnessTargets: () => [],
}));
vi.mock("@/hooks/use-actor-can-query", () => ({
  useActorCanQuery: () => true,
}));
vi.mock("@/hooks/use-suite-capabilities", () => ({
  useSuiteCapabilities: () => ({ capabilities: undefined }),
}));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));
vi.mock("@/hooks/use-test-case-steps-editor-enabled", () => ({
  useTestCaseStepsEditorEnabled: () => true,
}));

const prompt = (text: string): TestStep[] => [
  { id: "p1", kind: "prompt", prompt: text },
];
const promptBox = () =>
  screen.getByRole("textbox", { name: "What does the user ask?" });

describe("DescribeCaseSteps", () => {
  function Describe() {
    const [form, setForm] = useState<CaseSaveForm>({
      title: "Refunds",
      runs: 1,
      steps: prompt("Refund my order"),
      expectedOutput: "",
    });
    const [toolsChoice, setToolsChoice] = useState<ToolsChoice>("unset");
    return (
      <>
        <DescribeCaseSteps
          form={form}
          onFormChange={(update) => setForm(update)}
          toolsChoice={toolsChoice}
          onToolsChoiceChange={setToolsChoice}
          stashedTools={[]}
          onStashedToolsChange={vi.fn()}
          suite={suite}
          capabilities={undefined}
          availableTools={[]}
          onOpenSuiteSettings={vi.fn()}
          onDraftValidityChange={vi.fn()}
        />
        <output data-testid="form">{JSON.stringify(form)}</output>
      </>
    );
  }
  const form = () =>
    JSON.parse(screen.getByTestId("form").textContent ?? "{}") as CaseSaveForm;

  it("writes step edits into Describe's form and keeps its title", async () => {
    renderWithProviders(<Describe />);
    await userEvent.setup().type(promptBox(), " today");
    expect(form().steps).toEqual(prompt("Refund my order today"));
    expect(form().title).toBe("Refunds");
  });

  it("offers the case's judge opt-out and tool error switch", async () => {
    renderWithProviders(<Describe />);
    await userEvent
      .setup()
      .click(
        screen.getByRole("switch", { name: "Skip the judge for this case" }),
      );
    expect(form().judgeConfigOverride).toEqual({
      goalCompletion: { enabled: false },
    });
    expect(screen.getByTestId("case-tool-error-switch")).toBeInTheDocument();
  });
});

describe("Review case in the steps editor", () => {
  const scope = { projectId: "project", suiteId: "suite", suiteName: "Suite" };
  const key = evalSuiteKey(scope);
  const input = {
    suiteId: "suite",
    title: "Draw a box",
    query: "Draw a box",
    models: [],
    expectedToolCalls: [],
    runs: 1,
    isNegativeTest: false,
    expectedOutput: "A box",
    steps: prompt("Draw a box"),
  };
  const storedDraft = () =>
    useEvalGeneration
      .getState()
      .suites[key]!.drafts.find((draft) => draft.id === "d1")!;

  beforeEach(() => {
    registerEvalSuite(scope, {
      read: () => ({}),
      generate: async () => {},
      save: vi.fn(),
    });
    useEvalGeneration.setState({
      suites: {
        [key]: {
          status: "ready",
          drafts: [{ id: "d1", revision: "r1", input }],
          availableTools: [],
          suiteServers: ["excalidraw"],
          authoringSource: "generation",
        },
      },
    } as never);
  });

  function renderDrafts() {
    renderWithProviders(
      <EvalGeneratedDrafts
        projectId="project"
        suiteId="suite"
        suiteName="Suite"
      />,
    );
  }

  it("opens a generated case as steps and writes edits to the draft", async () => {
    renderDrafts();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Review case" }));
    expect(screen.getByTestId("case-steps-editor")).toBeInTheDocument();
    await user.type(promptBox(), " now");
    expect(storedDraft().input.steps).toEqual(prompt("Draw a box now"));
    expect(storedDraft().input.query).toBe("Draw a box now");
  });

  it("hides the switches a draft cannot store", async () => {
    renderDrafts();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Review case" }));
    expect(
      screen.queryByRole("switch", { name: "Skip the judge for this case" }),
    ).toBeNull();
    expect(screen.queryByTestId("case-tool-error-switch")).toBeNull();
  });

  it("reloads the steps when the draft is edited elsewhere", async () => {
    renderDrafts();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Review case" }));
    act(() => {
      editGeneratedDraft(scope as never, "d1", "r1", {
        steps: prompt("Draw two boxes"),
      });
    });
    expect(promptBox()).toHaveValue("Draw two boxes");
  });

  it("shows the store's draft when the store refuses an edit", () => {
    // The store moved on (Ask MCPJam) before this editor saw the new revision.
    editGeneratedDraft(scope as never, "d1", "r1", { title: "Renamed" });
    const { result } = renderHook(() =>
      useGeneratedDraftSteps(
        scope as never,
        {
          id: "d1",
          revision: "r1",
          input,
        } as never,
      ),
    );
    act(() =>
      result.current.onDraftChange((draft) => ({ ...draft, title: "Mine" })),
    );
    expect(result.current.draft.title).toBe("Draw a box");
    expect(storedDraft().input.title).toBe("Renamed");
  });

  it("opens an imported case as steps without a click", () => {
    useEvalGeneration.setState(
      (state) =>
        ({
          suites: {
            [key]: {
              ...state.suites[key]!,
              authoringSource: "import",
              drafts: [
                {
                  id: "d1",
                  revision: "r1",
                  input,
                  authoring: {
                    version: 1,
                    draftId: "d1",
                    revision: 0,
                    source: { fileName: "cases.md" },
                    additions: [],
                    review: "required",
                    issues: [],
                    case: {
                      title: "Draw a box",
                      steps: input.steps,
                      runs: 1,
                      models: [],
                    },
                  },
                },
              ],
            },
          },
        }) as never,
    );
    renderDrafts();
    expect(screen.getByTestId("case-steps-editor")).toBeInTheDocument();
    expect(promptBox()).toHaveValue("Draw a box");
  });
});
