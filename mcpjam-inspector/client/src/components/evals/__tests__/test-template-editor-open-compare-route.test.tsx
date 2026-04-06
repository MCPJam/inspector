import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { TestTemplateEditor } from "../test-template-editor";
import type { EvalIteration } from "../types";

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
  listEvalTools: vi.fn().mockResolvedValue([]),
  runEvalTestCase: vi.fn(),
  streamEvalTestCase: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: (_name: unknown) => useMutationMock(),
  useQuery: (name: unknown, args: unknown) => useQueryMock(name, args),
  useAction: () => vi.fn(),
}));

describe("TestTemplateEditor openCompareFromRoute", () => {
  const baseIteration: EvalIteration = {
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
      query: "Q",
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
    query: "Q",
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

  it("opens compare run mode and clears route when openCompareFromRoute is set", async () => {
    const onClearOpenCompareRoute = vi.fn();

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
        openCompareFromRoute
        onClearOpenCompareRoute={onClearOpenCompareRoute}
      />,
    );

    await waitFor(() => {
      expect(onClearOpenCompareRoute).toHaveBeenCalled();
      expect(screen.queryByText("No compare run yet")).not.toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /retry all/i }),
    ).toBeInTheDocument();
  });

  it("renders flat User prompt / Tool triggered for a single-turn case", async () => {
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
        onExportDraft={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("User prompt")).toBeInTheDocument();
    });

    expect(screen.getByText("Tool triggered")).toBeInTheDocument();
    expect(screen.queryByText("Prompt steps")).not.toBeInTheDocument();
  });
});
