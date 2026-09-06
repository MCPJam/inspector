import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import {
  getStepsBlockReason,
  TestTemplateEditor,
} from "../test-template-editor";
import type { TestStep } from "@/shared/steps";
import { MAX_SCRIPTED_WAIT_MS } from "@/shared/scripted-steps";

function renderWithProviders(ui: ReactElement) {
  return render(
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      {ui}
    </PreferencesStoreProvider>,
  );
}

const useMutationMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const useQueryMock = vi.hoisted(() => vi.fn());
const useAuthMock = vi.hoisted(() => ({
  getAccessToken: vi.fn().mockResolvedValue("token"),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => useAuthMock,
}));

vi.mock("@/hooks/use-ai-provider-keys", () => ({
  useAiProviderKeys: () => ({
    getToken: vi.fn().mockResolvedValue("key"),
    hasToken: vi.fn().mockReturnValue(true),
  }),
}));

vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => false,
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: () => "test",
  detectPlatform: () => "web",
}));

vi.mock("@/lib/apis/evals-api", () => ({
  listEvalTools: vi.fn().mockResolvedValue({ tools: [] }),
  runEvalTestCase: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: (_name: unknown) => useMutationMock(),
  useQuery: (name: unknown, args: unknown) => useQueryMock(name, args),
  useAction: () => vi.fn(),
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  useConvex: () => ({ query: vi.fn() }),
}));

describe("getStepsBlockReason", () => {
  it("returns guidance when a single step has no prompt", () => {
    expect(
      getStepsBlockReason([{ id: "1", kind: "prompt", prompt: "" }]),
    ).toBe("Enter a user prompt before run or save.");
  });

  it("returns null for a valid no-tool (negative) case with prompt", () => {
    expect(
      getStepsBlockReason([{ id: "1", kind: "prompt", prompt: "Hello" }]),
    ).toBeNull();
  });

  it("lists steps when multiple prompts are missing", () => {
    const steps: TestStep[] = [
      { id: "1", kind: "prompt", prompt: "a" },
      { id: "2", kind: "prompt", prompt: "" },
      { id: "3", kind: "prompt", prompt: "" },
    ];
    expect(getStepsBlockReason(steps)).toBe(
      "Enter a user prompt for step(s) 2, 3.",
    );
  });

  it("returns tool-fix message when an expected tool call is incomplete", () => {
    const steps: TestStep[] = [
      { id: "1", kind: "prompt", prompt: "Hi" },
      {
        id: "2",
        kind: "assert",
        assertion: { type: "toolCalledWith", toolName: "", args: { args: {} } },
      },
    ];
    expect(getStepsBlockReason(steps)).toBe(
      "Finish tool names and arguments, or remove incomplete expected tools.",
    );
  });
});

/**
 * The mutation rejects an incomplete widget step with a raw `ConvexError`
 * (CONVEX-1PD, CONVEX-1P2), so every gap the backend `assertValidSteps` checks
 * has to block Save/Run here first — including the placeholders the Add Step
 * picker seeds.
 */
describe("getStepsBlockReason: widget steps", () => {
  const withInteract = (
    action: unknown,
    toolName = "create_view",
  ): TestStep[] =>
    [
      { id: "1", kind: "prompt", prompt: "Draw a cat" },
      { id: "2", kind: "interact", toolName, action },
    ] as TestStep[];

  const withAssertion = (assertion: unknown): TestStep[] =>
    [
      { id: "1", kind: "prompt", prompt: "Draw a cat" },
      { id: "2", kind: "assert", assertion },
    ] as TestStep[];

  it("blocks a freshly added interact step on its empty view tool", () => {
    // Exactly what the Add Step picker seeds.
    expect(
      getStepsBlockReason(
        withInteract({ kind: "click", target: { testId: "" } }, ""),
      ),
    ).toBe("Pick a view (tool) for the click step.");
  });

  it("blocks a click whose target is the empty testId placeholder", () => {
    expect(
      getStepsBlockReason(
        withInteract({ kind: "click", target: { testId: "" } }),
      ),
    ).toBe("Pick an element target for the click step.");
  });

  it("blocks a click whose target has no reference point at all", () => {
    expect(
      getStepsBlockReason(withInteract({ kind: "click", target: {} })),
    ).toBe("Pick an element target for the click step.");
  });

  it("blocks a role locator with an empty ARIA role", () => {
    // A truthy `role` object satisfies the backend's "at least one of" check and
    // then fails its non-empty-role check, so it has to be caught here too.
    expect(
      getStepsBlockReason(
        withInteract({ kind: "click", target: { role: { role: "" } } }),
      ),
    ).toBe("Pick an element target for the click step.");
  });

  it("blocks a type step whose target is whitespace only", () => {
    expect(
      getStepsBlockReason(
        withInteract({ kind: "type", target: { css: "  " }, text: "hi" }),
      ),
    ).toBe("Pick an element target for the type step.");
  });

  it("blocks a key step with no key", () => {
    expect(getStepsBlockReason(withInteract({ kind: "key", key: "" }))).toBe(
      "Enter a key for the key step.",
    );
  });

  it("blocks a wait step whose ms field was cleared to 0", () => {
    expect(getStepsBlockReason(withInteract({ kind: "wait", ms: 0 }))).toBe(
      `Wait must be a whole number of milliseconds between 1 and ${MAX_SCRIPTED_WAIT_MS}.`,
    );
  });

  it("blocks a scroll step with a fractional amount", () => {
    expect(
      getStepsBlockReason(
        withInteract({ kind: "scroll", direction: "down", amount: 1.5 }),
      ),
    ).toBe("Scroll amount must be a whole number of 1 or more.");
  });

  it("passes a complete interact step", () => {
    expect(
      getStepsBlockReason(
        withInteract({
          kind: "click",
          target: { role: { role: "button", name: "Add to cart" } },
        }),
      ),
    ).toBeNull();
  });

  it("blocks a widget assertion on its empty element target", () => {
    expect(
      getStepsBlockReason(
        withAssertion({
          kind: "elementVisible",
          toolName: "create_view",
          target: { testId: "" },
        }),
      ),
    ).toBe("Pick an element target for the element visible check.");
  });

  it("blocks a widget assertion on its empty view tool", () => {
    expect(
      getStepsBlockReason(
        withAssertion({ kind: "textVisible", toolName: "", text: "Saved!" }),
      ),
    ).toBe("Pick a view (tool) for the text visible check.");
  });

  it("blocks widgetToolCalled with no called tool", () => {
    expect(
      getStepsBlockReason(
        withAssertion({
          kind: "widgetToolCalled",
          toolName: "create_view",
          calledToolName: "",
        }),
      ),
    ).toBe("Enter the tool name the view is expected to call.");
  });

  // `normalizeSteps` and the legacy `widgetChecks` bridge cast stored blobs to
  // the step types without checking leaf fields, and this runs in the editor's
  // render-time `useMemo` — a throw here blanks the pane instead of reporting
  // the gap.
  it("blocks an interact step with no action instead of throwing", () => {
    for (const action of [undefined, null]) {
      expect(getStepsBlockReason(withInteract(action))).toBe(
        "Pick an action for the interact step.",
      );
    }
  });

  it("blocks an interact step whose action kind is unknown", () => {
    expect(getStepsBlockReason(withInteract({ kind: "teleport" }))).toBe(
      "Pick an action for the interact step.",
    );
  });

  it("blocks a locator whose role bundle is malformed", () => {
    for (const role of [null, {}]) {
      expect(
        getStepsBlockReason(withInteract({ kind: "click", target: { role } })),
      ).toBe("Pick an element target for the click step.");
    }
  });

  it("blocks a widget assertion whose kind is unknown", () => {
    expect(
      getStepsBlockReason(
        withAssertion({ kind: "teleported", toolName: "create_view" }),
      ),
    ).toBe("Pick a check type for the widget check.");
  });

  it("names the turn when the case has more than one", () => {
    const steps = [
      { id: "1", kind: "prompt", prompt: "Draw a cat" },
      { id: "2", kind: "prompt", prompt: "Now save it" },
      {
        id: "3",
        kind: "interact",
        toolName: "create_view",
        action: { kind: "click", target: { testId: "" } },
      },
    ] as TestStep[];
    expect(getStepsBlockReason(steps)).toBe(
      "Pick an element target for the click step. (turn 2)",
    );
  });
});

describe("TestTemplateEditor prompt validation UI", () => {
  const baseIteration = {
    _id: "iter-1",
    testCaseId: "case-1",
    createdBy: "u1",
    createdAt: Date.now() - 10_000,
    updatedAt: Date.now() - 1_000,
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    resultSource: "reported",
    actualToolCalls: [],
    tokensUsed: 10,
    testCaseSnapshot: {
      title: "T",
      query: "",
      provider: "openai",
      model: "gpt-4",
      expectedToolCalls: [],
    },
    suiteRunId: "run-1",
  };

  const caseDoc = {
    _id: "case-1",
    testSuiteId: "suite-1",
    title: "T",
    query: "",
    models: [{ provider: "openai", model: "gpt-4" }],
    runs: 1,
    expectedToolCalls: [],
    runsConfig: [],
    advancedConfig: {},
    isNegativeTest: true,
    lastMessageRun: baseIteration._id,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useMutationMock.mockReturnValue(vi.fn());
    useQueryMock.mockImplementation((name: string, args: unknown) => {
      if (name === "testSuites:listTestCases") {
        return [caseDoc];
      }
      if (name === "testSuites:getTestSuite") {
        return {
          _id: "suite-1",
          environment: { servers: ["srv"] },
        };
      }
      if (
        name === "testSuites:getTestIteration" &&
        typeof args === "object" &&
        args !== null &&
        (args as { iterationId?: string }).iterationId === baseIteration._id
      ) {
        return baseIteration;
      }
      return undefined;
    });
  });

  it("shows the converter's mapping note READ-ONLY, in claim wording", async () => {
    const claim = {
      status: "exact" as const,
      sourceCaseKey: "upstream/refunds/duplicate-charge",
      note: "1:1 with the upstream single-turn assertion form.",
    };
    useQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:listTestCases") {
        return [{ ...caseDoc, import: claim }];
      }
      if (name === "testSuites:getTestSuite") {
        return { _id: "suite-1", environment: { servers: ["srv"] } };
      }
      return undefined;
    });

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
        availableModels={[
          { provider: "openai", model: "gpt-4", label: "GPT-4" } as any,
        ]}
        suiteIterations={[]}
      />,
    );

    const details = await screen.findByTestId("import-claim-details");
    expect(details).toHaveTextContent("claimed exact");
    expect(details).toHaveTextContent(
      "1:1 with the upstream single-turn assertion form.",
    );
    expect(details).toHaveTextContent("upstream/refunds/duplicate-charge");
    // Never "verified" or "accepted": the converter claimed this, MCPJam did
    // not check it.
    expect(details).toHaveTextContent(/has not verified/i);
    // READ-ONLY. Making the note editable here would let somebody rewrite the
    // justification for a claim without changing the claim, which is the one
    // edit that makes the record actively misleading.
    expect(details.querySelector("input")).toBeNull();
    expect(details.querySelector("textarea")).toBeNull();
  });

  it("shows nothing for a natively authored case", async () => {
    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
        availableModels={[
          { provider: "openai", model: "gpt-4", label: "GPT-4" } as any,
        ]}
        suiteIterations={[baseIteration]}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Enter the user prompt…"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("import-claim-details")).toBeNull();
  });

  it("marks empty user prompt and disables Run", async () => {
    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
        availableModels={[
          {
            provider: "openai",
            model: "gpt-4",
            label: "GPT-4",
          } as any,
        ]}
        suiteIterations={[baseIteration]}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Enter the user prompt…"),
      ).toBeInTheDocument();
    });

    const promptInput = screen.getByPlaceholderText("Enter the user prompt…");
    expect(promptInput).toHaveAttribute("aria-invalid", "true");

    const runButton = screen.getByRole("button", { name: /Quick Run/ });
    expect(runButton).toBeDisabled();
  });
});
