/**
 * Phase 3 (extended in Phase 4) contract test: when the card receives an
 * explicit `hostSnapshot` prop, its inner subtree's `useContext()` reads
 * must return the snapshot field (not the tab-root context value). The
 * contract covers all three shadowed providers — `hostCapabilitiesOverride`,
 * `chatUiOverride`, `mcpProfile` — and the `hostCapsResolver` scope (which
 * is gated by a separate prop because the resolver is not part of the
 * persisted host config shape).
 *
 * This is the contract the Phase 4 multi-host render path depends on —
 * without provider shadowing inside the card, two host columns would read
 * the same global host-snapshot from the tab root.
 *
 * Uses REAL context modules (no vi.mock on the providers) so the contract
 * is exercised end-to-end. We stub `useChatSession` and a few heavy
 * children that the card pulls in only because they share the file.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MultiModelPlaygroundCard } from "../multi-model-playground-card";
import {
  ChatboxHostCapabilitiesOverrideProvider,
  useChatboxHostCapabilitiesOverride,
} from "@/contexts/chatbox-client-capabilities-override-context";
import {
  ChatboxChatUiOverrideProvider,
  useChatboxChatUiOverride,
} from "@/contexts/chatbox-client-style-context";
import {
  ActiveMcpProfileProvider,
  useActiveMcpProfile,
} from "@/contexts/active-mcp-profile-context";
import { useActiveHostCapsResolver } from "@/contexts/active-host-client-capabilities-context";
import type { HostSnapshot } from "@/lib/host-snapshot";
import type { HostConfigMcpProfileV1 } from "@/lib/client-config-v2";

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

// The Thread component is our chat-branch probe: emits the inner reads
// for `hostCapabilitiesOverride`, `chatUiOverride`, and the resolver
// presence as data attributes / JSON text so assertions can verify per
// context independently.
// The Thread component is our probe. The Phase 3 provider lift placed
// all four shadowed providers (hostCaps, chatUi, mcpProfile, hostCaps
// resolver) ABOVE the chat AND trace branches under one stack, so a
// chat-branch read is sufficient evidence that any other branch under
// the same card body sees the same value — there's literally one
// provider tree above all of them.
vi.mock("@/components/chat-v2/thread", () => ({
  Thread: () => {
    const hostCapsOverride = useChatboxHostCapabilitiesOverride();
    const chatUiOverride = useChatboxChatUiOverride();
    const mcpProfile = useActiveMcpProfile();
    const resolver = useActiveHostCapsResolver();
    // Resolver is a function; we can't serialize it. Probe it by
    // calling with a sentinel serverId — NO_OP_RESOLVER returns
    // undefined, the real ActiveHostCapsResolverScope returns a caps
    // object (possibly `{}`).
    const resolverProbe = resolver("probe-server-id");
    return (
      <div>
        <div data-testid="thread-host-caps-override">
          {JSON.stringify(hostCapsOverride)}
        </div>
        <div data-testid="thread-chat-ui-override">
          {JSON.stringify(chatUiOverride)}
        </div>
        <div data-testid="thread-mcp-profile">{JSON.stringify(mcpProfile)}</div>
        <div data-testid="thread-resolver-probe">
          {JSON.stringify(resolverProbe ?? null)}
        </div>
      </div>
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

const baseProps = {
  compareId: String(model.id),
  compareLabel: model.name,
  compareKind: "model" as const,
  model,
  comparisonSummaries: [],
  selectedServers: [],
  broadcastRequest: null,
  deterministicExecutionRequest: null,
  stopRequestId: 0,
  executionConfig: {
    systemPrompt: "",
    temperature: 0.7,
    requireToolApproval: false,
  },
  displayMode: "inline" as const,
  onDisplayModeChange: vi.fn(),
  hostStyle: "chatgpt" as const,
  effectiveThreadTheme: "light" as const,
  deviceType: "desktop" as const,
  selectedProtocol: null,
  onSummaryChange: vi.fn(),
};

function setMessagesWithContent() {
  mockUseChatSession.messages = [
    { id: "m-1", role: "user", parts: [{ type: "text", text: "hi" }] },
    { id: "m-2", role: "assistant", parts: [{ type: "text", text: "hi" }] },
  ] as (typeof mockUseChatSession)["messages"];
}

describe("MultiModelPlaygroundCard provider shadowing (chat branch)", () => {
  it("inner Thread sees the per-card hostCapabilitiesOverride from hostSnapshot, not the tab-root context", () => {
    setMessagesWithContent();
    const tabRootValue = { foo: "tab-root" };
    const perCardValue = { foo: "per-card" };

    const hostSnapshot: HostSnapshot = {
      hostStyle: "chatgpt",
      hostCapabilitiesOverride: perCardValue,
      chatUiOverride: undefined,
      mcpProfile: undefined,
    };

    render(
      <ChatboxHostCapabilitiesOverrideProvider value={tabRootValue}>
        <MultiModelPlaygroundCard {...baseProps} hostSnapshot={hostSnapshot} />
      </ChatboxHostCapabilitiesOverrideProvider>,
    );

    expect(screen.getByTestId("thread-host-caps-override").textContent).toBe(
      JSON.stringify(perCardValue),
    );
  });

  it("inner Thread sees the per-card chatUiOverride from hostSnapshot", () => {
    setMessagesWithContent();
    const tabRootChatUi = {
      identifier: { logoUrl: "tab-root-logo" },
    } as unknown as NonNullable<HostSnapshot["chatUiOverride"]>;
    const perCardChatUi = {
      identifier: { logoUrl: "per-card-logo" },
    } as unknown as NonNullable<HostSnapshot["chatUiOverride"]>;

    const hostSnapshot: HostSnapshot = {
      hostStyle: "chatgpt",
      hostCapabilitiesOverride: undefined,
      chatUiOverride: perCardChatUi,
      mcpProfile: undefined,
    };

    render(
      <ChatboxChatUiOverrideProvider value={tabRootChatUi}>
        <MultiModelPlaygroundCard {...baseProps} hostSnapshot={hostSnapshot} />
      </ChatboxChatUiOverrideProvider>,
    );

    expect(screen.getByTestId("thread-chat-ui-override").textContent).toBe(
      JSON.stringify(perCardChatUi),
    );
  });

  it("without hostSnapshot, inner Thread falls back to the tab-root context value", () => {
    setMessagesWithContent();
    const tabRootValue = { foo: "tab-root" };

    render(
      <ChatboxHostCapabilitiesOverrideProvider value={tabRootValue}>
        <MultiModelPlaygroundCard {...baseProps} />
      </ChatboxHostCapabilitiesOverrideProvider>,
    );

    expect(screen.getByTestId("thread-host-caps-override").textContent).toBe(
      JSON.stringify(tabRootValue),
    );
  });
});

describe("MultiModelPlaygroundCard mcpProfile shadow", () => {
  // The Phase 3 provider lift wraps the WHOLE card body (chat + trace +
  // raw) under one stack. The chat-branch Thread probe reads the same
  // ActiveMcpProfileContext value the trace-branch TraceViewer would —
  // both branches sit under the same single ActiveMcpProfileProvider
  // mounted by the card. Asserting the chat-branch read is therefore
  // sufficient evidence the trace branch reads the same shadowed value.
  it("when hostSnapshot.mcpProfile is set, the inner subtree reads per-card profile (not tab-root)", () => {
    setMessagesWithContent();

    const tabRootProfile: HostConfigMcpProfileV1 = {
      profileVersion: 1,
      initialize: { clientInfo: { name: "tab-root" } },
    };
    const perCardProfile: HostConfigMcpProfileV1 = {
      profileVersion: 1,
      initialize: { clientInfo: { name: "per-card" } },
    };

    const hostSnapshot: HostSnapshot = {
      hostStyle: "chatgpt",
      hostCapabilitiesOverride: undefined,
      chatUiOverride: undefined,
      mcpProfile: perCardProfile,
    };

    render(
      <ActiveMcpProfileProvider value={tabRootProfile}>
        <MultiModelPlaygroundCard {...baseProps} hostSnapshot={hostSnapshot} />
      </ActiveMcpProfileProvider>,
    );

    expect(screen.getByTestId("thread-mcp-profile").textContent).toBe(
      JSON.stringify(perCardProfile),
    );
  });

  it("without hostSnapshot, the inner subtree falls back to the tab-root mcpProfile", () => {
    setMessagesWithContent();
    const tabRootProfile: HostConfigMcpProfileV1 = {
      profileVersion: 1,
      initialize: { clientInfo: { name: "tab-root" } },
    };

    render(
      <ActiveMcpProfileProvider value={tabRootProfile}>
        <MultiModelPlaygroundCard {...baseProps} />
      </ActiveMcpProfileProvider>,
    );

    expect(screen.getByTestId("thread-mcp-profile").textContent).toBe(
      JSON.stringify(tabRootProfile),
    );
  });
});

describe("MultiModelPlaygroundCard hostCapsResolver scope", () => {
  it("when hostCapsResolver is passed, the ActiveHostCapsResolverScope wraps the card body", () => {
    setMessagesWithContent();

    const fakeHostConfig = {
      id: "h1",
      schemaVersion: 1,
      hostStyle: "chatgpt",
      modelId: "openai/gpt-5-mini",
      systemPrompt: "",
      temperature: 0.7,
      requireToolApproval: false,
      serverIds: [],
      optionalServerIds: [],
      connectionDefaults: { headers: {}, requestTimeout: 30000 },
      clientCapabilities: {},
      hostContext: {},
    } as unknown as Parameters<
      typeof MultiModelPlaygroundCard
    >[0]["hostCapsResolver"];

    render(
      <MultiModelPlaygroundCard
        {...baseProps}
        hostCapsResolver={fakeHostConfig}
      />,
    );

    // The Thread mock probe calls `useActiveHostCapsResolver(...)("probe-server-id")`.
    // With `hostCapsResolver` set, the card wraps the body in
    // `ActiveHostCapsResolverScope`, whose resolver evaluates against the
    // synthesized effective host. Without the scope, the context default
    // (`NO_OP_RESOLVER`) returns undefined. We assert the scope mounted by
    // checking that the resolver returns SOMETHING (a caps object), which
    // means it's the real `ActiveHostCapsResolverScope` resolver.
    const probe = screen.getByTestId("thread-resolver-probe").textContent;
    expect(probe).not.toBe("null"); // NO_OP_RESOLVER would yield null
  });

  it("without hostCapsResolver, the resolver context falls through to the tab-root default", () => {
    setMessagesWithContent();

    render(<MultiModelPlaygroundCard {...baseProps} />);

    // No scope wrapping → NO_OP_RESOLVER → undefined → "null" via JSON.
    expect(screen.getByTestId("thread-resolver-probe").textContent).toBe(
      "null",
    );
  });
});
