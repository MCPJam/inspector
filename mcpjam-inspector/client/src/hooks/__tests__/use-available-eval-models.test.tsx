import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAvailableEvalModels } from "../use-available-eval-models";

const {
  mockBuildAvailableModelsFromOrgConfig,
  mockDetectOllamaModels,
  mockDetectOllamaToolCapableModels,
} = vi.hoisted(() => ({
  mockBuildAvailableModelsFromOrgConfig: vi.fn(),
  mockDetectOllamaModels: vi.fn(),
  mockDetectOllamaToolCapableModels: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: () => ({
    providers: [
      {
        providerKey: "openai",
        enabled: true,
      },
    ],
  }),
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({
    activeProjectId: "project-1",
    projects: {
      "project-1": {
        _id: "project-1",
        organizationId: "org-1",
      },
    },
  }),
}));

vi.mock("@/hooks/use-ollama-config", () => ({
  useOllamaConfig: () => ({
    getOllamaBaseUrl: vi.fn().mockReturnValue("http://127.0.0.1:11434/api"),
  }),
}));

vi.mock("@/lib/ollama-utils", () => ({
  detectOllamaModels: (...args: unknown[]) => mockDetectOllamaModels(...args),
  detectOllamaToolCapableModels: (...args: unknown[]) =>
    mockDetectOllamaToolCapableModels(...args),
}));

vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModelsFromOrgConfig: (...args: unknown[]) =>
    mockBuildAvailableModelsFromOrgConfig(...args),
}));

describe("useAvailableEvalModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectOllamaModels.mockResolvedValue({
      isRunning: true,
      availableModels: ["llama3.2"],
    });
    mockDetectOllamaToolCapableModels.mockResolvedValue(["llama3.2"]);
    mockBuildAvailableModelsFromOrgConfig.mockReturnValue([
      {
        id: "openai/gpt-5-mini",
        name: "GPT-5 mini",
        provider: "openai",
      },
    ]);
  });

  it("builds eval models without instantiating chat state", async () => {
    const { result } = renderHook(() => useAvailableEvalModels());

    await waitFor(() => {
      expect(result.current.availableModels).toEqual([
        {
          id: "openai/gpt-5-mini",
          name: "GPT-5 mini",
          provider: "openai",
        },
        {
          id: "llama3.2",
          name: "llama3.2",
          provider: "ollama",
          disabled: false,
          disabledReason: undefined,
        },
      ]);
    });

    expect(mockDetectOllamaModels).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api"
    );
    expect(mockDetectOllamaToolCapableModels).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api"
    );
    expect(mockBuildAvailableModelsFromOrgConfig).toHaveBeenCalledWith({
      providers: [
        {
          providerKey: "openai",
          enabled: true,
        },
      ],
    });
  });
});
