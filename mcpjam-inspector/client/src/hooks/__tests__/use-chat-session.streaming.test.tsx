import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useState } from "react";
import type { UIMessageChunk } from "ai";
import type { MultiModelCardSummary } from "@/components/chat-v2/model-compare-card-header";
import { MultiModelPlaygroundCard } from "@/components/ui-playground/multi-model-playground-card";

const mockState = vi.hoisted(() => ({
  empty: [] as never[],
  appState: { servers: {} },
  getAccessToken: vi.fn(async () => "member"),
  hasToken: vi.fn(() => false),
  getToken: vi.fn(() => ""),
  getOpenRouterSelectedModels: vi.fn(() => []),
  getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
  getAzureBaseUrl: vi.fn(() => ""),
  getCustomProviderByName: vi.fn(),
  setSelectedModelId: vi.fn(),
  getToolsMetadata: vi.fn(async () => ({
    metadata: {},
    toolServerMap: {},
    tokenCounts: null,
  })),
  countTextTokens: vi.fn(async () => null),
  convexAuth: {
    isAuthenticated: true,
    isLoading: false,
  },
  detectOllamaModels: vi.fn(async () => ({
    isRunning: false,
    availableModels: [],
  })),
  detectOllamaToolCapableModels: vi.fn(async () => []),
  idCounter: 0,
}));

const mcpJamModel = {
  id: "openai/gpt-5-mini",
  name: "GPT-5 Mini",
  provider: "openai" as const,
};

function nextSessionId() {
  mockState.idCounter += 1;
  return `chat-session-${mockState.idCounter}`;
}

vi.mock("@/lib/config", async () => ({
  ...(await vi.importActual("@/lib/config")),
  HOSTED_MODE: false,
}));

vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModels: vi.fn(() => [mcpJamModel]),
  getDefaultModel: vi.fn(() => mcpJamModel),
  isMCPJamProvidedModelMenuItem: vi.fn((model: { id: string }) =>
    String(model.id).includes("/"),
  ),
}));

// The hosted-model catalog hook fetches `/api/mcp/models` for everyone now;
// stub it so it doesn't run a real fetch in this hook test.
vi.mock("@/hooks/use-hosted-model-catalog", () => ({
  useHostedModelCatalog: () => ({
    hostedCatalog: mockState.empty,
    status: "fallback",
  }),
}));

vi.mock("@/hooks/use-ai-provider-keys", () => ({
  useAiProviderKeys: () => ({
    hasToken: mockState.hasToken,
    getToken: mockState.getToken,
    getOpenRouterSelectedModels: mockState.getOpenRouterSelectedModels,
    getOllamaBaseUrl: mockState.getOllamaBaseUrl,
    getAzureBaseUrl: mockState.getAzureBaseUrl,
  }),
}));

vi.mock("@/hooks/use-custom-providers", () => ({
  useCustomProviders: () => ({
    customProviders: mockState.empty,
    getCustomProviderByName: mockState.getCustomProviderByName,
  }),
}));

vi.mock("@/hooks/use-persisted-model", () => ({
  usePersistedModel: () => ({
    selectedModelId: "openai/gpt-5-mini",
    setSelectedModelId: mockState.setSelectedModelId,
    selectedModelIds: ["openai/gpt-5-mini"],
    setSelectedModelIds: vi.fn(),
    multiModelEnabled: false,
    setMultiModelEnabled: vi.fn(),
  }),
}));

vi.mock("@/hooks/useSharedChatWidgetCapture", () => ({
  useSharedChatWidgetCapture: vi.fn(),
}));

vi.mock("@/lib/ollama-utils", () => ({
  detectOllamaModels: mockState.detectOllamaModels,
  detectOllamaToolCapableModels: mockState.detectOllamaToolCapableModels,
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  getToolsMetadata: mockState.getToolsMetadata,
}));

vi.mock("@/lib/apis/mcp-tokenizer-api", () => ({
  countTextTokens: mockState.countTextTokens,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
  getAuthHeaders: vi.fn(() => ({})),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: mockState.getAccessToken,
  }),
}));

// Soft reads (billing, credits, quota, notifications) go through useQueries;
// withUseQueries answers them from this mock's useQuery.
vi.mock("convex/react", async () =>
  (await import("@/test/mocks/convex-use-queries")).withUseQueries({
  // useChatSession resolves the Convex client to submit elicitation answers
  // straight to the rendezvous table (the blocked replica isn't addressable).
  useConvex: () => ({ mutation: vi.fn().mockResolvedValue({ ok: true }) }),
  useConvexAuth: () => mockState.convexAuth,
  // useChatSession reads the credit balance (to lock free models at 0
  // credits); no balance in these tests → outOfCredits resolves false.
  useQuery: () => undefined,
}));

vi.mock("ai", async () => ({
  ...(await vi.importActual<typeof import("ai")>("ai")),
  generateId: () => nextSessionId(),
  DefaultChatTransport: class {
    async sendMessages() {
      const code =
        "# Excel upload\n\n```python\n" +
        "print('hello')\n".repeat(120) +
        "```\n\n" +
        "Long output explaining how to upload and parse an Excel spreadsheet.\n\n".repeat(
          80,
        );
      const chunks: UIMessageChunk[] = [
        { type: "start", messageId: "assistant" },
        {
          type: "data-trace-event",
          transient: true,
          data: {
            type: "turn_start",
            turnId: "turn",
            promptIndex: 0,
            startedAtMs: Date.now(),
          },
        },
        { type: "text-start", id: "text" },
      ];
      for (let i = 0; i < code.length; i += 6) {
        const delta = code.slice(i, i + 6);
        chunks.push({ type: "text-delta", id: "text", delta });
        chunks.push({
          type: "data-trace-event",
          transient: true,
          data: {
            type: "text_delta",
            turnId: "turn",
            promptIndex: 0,
            stepIndex: 0,
            delta,
          },
        });
      }
      chunks.push(
        { type: "text-end", id: "text" },
        {
          type: "data-trace-event",
          transient: true,
          data: { type: "turn_finish", turnId: "turn", promptIndex: 0 },
        },
        { type: "finish" },
      );
      let i = 0;
      return new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (i === chunks.length) controller.close();
          else
            for (let batch = 0; batch < 200 && i < chunks.length; batch++)
              controller.enqueue(chunks[i++]);
        },
      });
    }
    async reconnectToStream() {
      return null;
    }
  },
}));
vi.mock("@/lib/guest-session", async () => ({
  ...(await vi.importActual("@/lib/guest-session")),
  getCachedGuestSession: () => null,
  getOrCreateGuestSession: async () => ({
    token: "guest",
    expiresAt: Date.now() + 100000,
  }),
}));
vi.mock("@/components/evals/trace-viewer", () => ({
  TraceViewer: () => <div data-testid="trace-viewer" />,
}));

vi.mock("@/components/chat-v2/error", () => ({
  ErrorBox: () => <div data-testid="error-box" />,
}));

vi.mock("@/components/chat-v2/shared/chat-helpers", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/components/chat-v2/shared/chat-helpers")
  >();
  return {
    ...actual,
    formatErrorMessage: () => null,
  };
});

vi.mock("@/components/chat-v2/model-compare-card-header", () => ({
  ModelCompareCardHeader: ({
    model,
    showComparisonChrome = true,
    showTraceTabs,
  }: {
    model: { name: string };
    showComparisonChrome?: boolean;
    showTraceTabs: boolean;
  }) => {
    if (!showComparisonChrome && !showTraceTabs) {
      return null;
    }
    return <div data-testid="compare-card-header">{model.name}</div>;
  },
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: <T,>(selector: (state: any) => T): T =>
    selector({ hostCapabilitiesOverride: null }),
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => mockState.appState,
  useOptionalSharedAppState: () => mockState.appState,
}));
function Harness() {
  const [summaries, setSummaries] = useState<
    Record<string, MultiModelCardSummary>
  >({});
  const [, setFlags] = useState<Record<string, boolean>>({});
  const [send, setSend] = useState(false);
  return (
    <>
      <button onClick={() => setSend(true)}>Send</button>
      <div data-testid="statuses">
        {Object.values(summaries)
          .map((s) => s.status)
          .join(",")}
      </div>
      {["Claude", "ChatGPT", "Cursor"].map((name, index) => (
        <MultiModelPlaygroundCard
          key={name}
          compareId={name}
          compareLabel={name}
          compareKind="host"
          model={mcpJamModel}
          comparisonSummaries={Object.values(summaries)}
          selectedServers={[]}
          broadcastRequest={
            send
              ? {
                  id: 1,
                  text: "Explain Excel upload",
                  files: [],
                  prependMessages: [],
                }
              : null
          }
          deterministicExecutionRequest={null}
          stopRequestId={0}
          executionConfig={{
            systemPrompt: "",
            temperature: 0.7,
            requireToolApproval: false,
          }}
          displayMode="inline"
          onDisplayModeChange={() => {}}
          hostStyle={index === 0 ? "claude" : "chatgpt"}
          effectiveThreadTheme="light"
          deviceType="desktop"
          onSummaryChange={(summary) =>
            setSummaries((previous) => ({
              ...previous,
              [summary.modelId]: summary,
            }))
          }
          onHasMessagesChange={(id, value) =>
            setFlags((previous) => ({ ...previous, [id]: value }))
          }
        />
      ))}
    </>
  );
}
it("finishes three buffered streams without update-depth errors or lost text", async () => {
  render(<Harness />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  screen.getByText("Send").click();
  // Use the real scheduler: act/waitFor would drain each burst's pending
  // renders and hide the update-depth failure we see during streaming.
  const deadline = Date.now() + 15000;
  while (
    screen.getByTestId("statuses").textContent !== "ready,ready,ready" &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(screen.getByTestId("statuses").textContent).toBe("ready,ready,ready");
  const replies = screen.getAllByRole("article");
  expect(replies).toHaveLength(3);
  for (const reply of replies) {
    expect(reply.textContent?.match(/print\('hello'\)/g)).toHaveLength(120);
    expect(reply.textContent?.match(/Long output explaining/g)).toHaveLength(
      80,
    );
  }
}, 20000);
