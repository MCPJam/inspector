import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import {
  getPromptTurnBlockReason,
  TestTemplateEditor,
} from "../test-template-editor";

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
}));

describe("getPromptTurnBlockReason", () => {
  it("returns guidance when a single step has no prompt", () => {
    expect(
      getPromptTurnBlockReason([
        { id: "1", prompt: "", expectedToolCalls: [] },
      ]),
    ).toBe("Enter a user prompt before run or save.");
  });

  it("returns null for a valid no-tool (negative) case with prompt", () => {
    expect(
      getPromptTurnBlockReason([
        { id: "1", prompt: "Hello", expectedToolCalls: [] },
      ]),
    ).toBeNull();
  });

  it("lists steps when multiple prompts are missing", () => {
    expect(
      getPromptTurnBlockReason([
        { id: "1", prompt: "a", expectedToolCalls: [] },
        { id: "2", prompt: "", expectedToolCalls: [] },
        { id: "3", prompt: "", expectedToolCalls: [] },
      ]),
    ).toBe("Enter a user prompt for step(s) 2, 3.");
  });

  it("returns tool-fix message when expected tools are incomplete", () => {
    expect(
      getPromptTurnBlockReason([
        {
          id: "1",
          prompt: "Hi",
          expectedToolCalls: [{ toolName: "", arguments: {} }],
        },
      ]),
    ).toBe(
      "Finish tool names and arguments, or remove incomplete expected tools.",
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
      if (name === "testSuites:listTestIterations" && args !== "skip") {
        return [baseIteration];
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

  it("marks empty user prompt and disables Run", async () => {
    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        workspaceId={null}
        availableModels={[
          {
            provider: "openai",
            model: "gpt-4",
            label: "GPT-4",
          } as any,
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Enter the user prompt…")).toBeInTheDocument();
    });

    const promptInput = screen.getByPlaceholderText("Enter the user prompt…");
    expect(promptInput).toHaveAttribute("aria-invalid", "true");

    const runButton = screen.getByRole("button", { name: /^Run$/ });
    expect(runButton).toBeDisabled();
  });
});
