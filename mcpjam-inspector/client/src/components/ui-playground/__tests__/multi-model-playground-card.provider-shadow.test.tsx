/**
 * Phase 3 contract test: when the card receives explicit per-card
 * host-snapshot props, its inner subtree's `useContext()` reads must
 * return the prop value (not the tab-root context value).
 *
 * This is the contract Phase 4 (multi-host render path) depends on —
 * without provider shadowing inside the card, two host columns would
 * read the same global host-snapshot from the tab root.
 *
 * Uses REAL context modules (no vi.mock) so the contract is exercised
 * end-to-end. We stub `useChatSession` and a few heavy children that
 * the card pulls in only because they share the file.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MultiModelPlaygroundCard } from "../multi-model-playground-card";
import {
  ChatboxHostCapabilitiesOverrideProvider,
  useChatboxHostCapabilitiesOverride,
} from "@/contexts/chatbox-client-capabilities-override-context";

// Stub use-stick-to-bottom so we don't need DOM measurement.
vi.mock("use-stick-to-bottom", () => {
  const StickToBottomComponent = ({
    children,
  }: {
    children: React.ReactNode;
  }) => <div data-testid="stick-to-bottom">{children}</div>;
  StickToBottomComponent.Content = ({
    children,
  }: {
    children: React.ReactNode;
  }) => <div>{children}</div>;
  return {
    StickToBottom: StickToBottomComponent,
    useStickToBottomContext: () => ({ isAtBottom: true, scrollToBottom: vi.fn() }),
  };
});

const mockUseChatSession = {
  messages: [],
  setMessages: vi.fn(),
  sendMessage: vi.fn(),
  stop: vi.fn(),
  status: "ready",
  error: undefined,
  chatSessionId: "chat-session-1",
  toolsMetadata: {},
  toolServerMap: {},
  liveTraceEnvelope: null,
  requestPayloadHistory: [],
  hasTraceSnapshot: false,
  hasLiveTimelineContent: false,
  traceViewsSupported: true,
  isStreaming: false,
  addToolApprovalResponse: vi.fn(),
  systemPrompt: "",
  startChatWithMessages: vi.fn(),
};

vi.mock("@/hooks/use-chat-session", () => ({
  useChatSession: () => mockUseChatSession,
}));

// The Thread component captures the inner `useChatboxHostCapabilitiesOverride`
// value and renders it as JSON so the test can assert on the shadowed value.
vi.mock("@/components/chat-v2/thread", () => ({
  Thread: () => {
    const inner = useChatboxHostCapabilitiesOverride();
    return (
      <div data-testid="thread-host-caps-override">{JSON.stringify(inner)}</div>
    );
  },
}));

vi.mock("@/components/evals/trace-viewer", () => ({
  TraceViewer: () => <div data-testid="trace-viewer" />,
}));

vi.mock("@/components/chat-v2/error", () => ({
  ErrorBox: () => <div data-testid="error-box" />,
}));

vi.mock("@/components/chat-v2/shared/chat-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/components/chat-v2/shared/chat-helpers")
    >();
  return {
    ...actual,
    formatErrorMessage: () => null,
  };
});

vi.mock("@/components/chat-v2/model-compare-card-header", () => ({
  ModelCompareCardHeader: () => <div data-testid="compare-card-header" />,
}));

const model = {
  id: "openai/gpt-5-mini",
  name: "GPT-5 Mini",
  provider: "openai" as const,
};

describe("MultiModelPlaygroundCard provider shadowing", () => {
  it("inner Thread sees the per-card hostCapabilitiesOverride prop, not the outer tab-root context", () => {
    // Set up a Thread that has at least one assistant message so the chat
    // branch renders (rather than the empty-thread placeholder, which
    // wouldn't expose the Thread component's context read).
    mockUseChatSession.messages = [
      { id: "m-1", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "m-2", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ] as (typeof mockUseChatSession)["messages"];

    const tabRootValue = { foo: "tab-root" };
    const perCardValue = { foo: "per-card" };

    render(
      <ChatboxHostCapabilitiesOverrideProvider value={tabRootValue}>
        <MultiModelPlaygroundCard
          compareId={String(model.id)}
          compareLabel={model.name}
          compareKind="model"
          model={model}
          comparisonSummaries={[]}
          selectedServers={[]}
          broadcastRequest={null}
          deterministicExecutionRequest={null}
          stopRequestId={0}
          executionConfig={{
            systemPrompt: "",
            temperature: 0.7,
            requireToolApproval: false,
          }}
          displayMode="inline"
          onDisplayModeChange={vi.fn()}
          hostStyle="chatgpt"
          effectiveThreadTheme="light"
          deviceType="desktop"
          selectedProtocol={null}
          onSummaryChange={vi.fn()}
          hostCapabilitiesOverride={perCardValue}
          hostCapabilitiesOverrideSet
        />
      </ChatboxHostCapabilitiesOverrideProvider>,
    );

    const rendered = screen.getByTestId("thread-host-caps-override");
    expect(rendered.textContent).toBe(JSON.stringify(perCardValue));
  });

  it("without the prop, inner Thread falls back to the tab-root context value", () => {
    mockUseChatSession.messages = [
      { id: "m-1", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "m-2", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ] as (typeof mockUseChatSession)["messages"];

    const tabRootValue = { foo: "tab-root" };

    render(
      <ChatboxHostCapabilitiesOverrideProvider value={tabRootValue}>
        <MultiModelPlaygroundCard
          compareId={String(model.id)}
          compareLabel={model.name}
          compareKind="model"
          model={model}
          comparisonSummaries={[]}
          selectedServers={[]}
          broadcastRequest={null}
          deterministicExecutionRequest={null}
          stopRequestId={0}
          executionConfig={{
            systemPrompt: "",
            temperature: 0.7,
            requireToolApproval: false,
          }}
          displayMode="inline"
          onDisplayModeChange={vi.fn()}
          hostStyle="chatgpt"
          effectiveThreadTheme="light"
          deviceType="desktop"
          selectedProtocol={null}
          onSummaryChange={vi.fn()}
          // No hostCapabilitiesOverride prop — should fall back to outer.
        />
      </ChatboxHostCapabilitiesOverrideProvider>,
    );

    const rendered = screen.getByTestId("thread-host-caps-override");
    expect(rendered.textContent).toBe(JSON.stringify(tabRootValue));
  });
});
