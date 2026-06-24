import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { useWebManagedServers } from "@/contexts/web-managed-servers-context";
import { McpjamAgentThread } from "../McpjamAgentThread";

const sessionMock = vi.hoisted(() => ({
  current: {
    status: "ready",
    model: { id: "gpt-5" },
    serversReady: true,
    hydrating: false,
    messages: [{ id: "m1", role: "assistant", parts: [] }],
    error: null,
    submit: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock("@/hooks/use-mcpjam-agent-session", () => ({
  useMcpjamAgentSession: () => sessionMock.current,
}));

vi.mock("@/components/mcpjam-agent/McpjamAgentComposer", () => ({
  McpjamAgentComposer: () => <div data-testid="composer" />,
}));

vi.mock("@/components/chat-v2/thread", () => ({
  Thread: () => {
    const webManagedServers = useWebManagedServers();
    return (
      <div data-testid="thread-web-managed">{String(webManagedServers)}</div>
    );
  },
}));

vi.mock("use-stick-to-bottom", () => {
  const StickToBottom = Object.assign(
    ({ children }: { children: React.ReactNode }) => (
      <div data-testid="stick-to-bottom">{children}</div>
    ),
    {
      Content: ({ children }: { children: React.ReactNode }) => (
        <div>{children}</div>
      ),
    }
  );
  return { StickToBottom };
});

vi.mock("@/components/chat-v2/shared/scroll-to-bottom-button", () => ({
  ScrollToBottomButton: () => null,
}));

function renderThread() {
  return render(
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <McpjamAgentThread
        sessionId="session-1"
        projectId="project-1"
        organizationId="org-1"
        surface="home"
      />
    </PreferencesStoreProvider>
  );
}

describe("McpjamAgentThread", () => {
  beforeEach(() => {
    sessionMock.current = {
      status: "ready",
      model: { id: "gpt-5" },
      serversReady: true,
      hydrating: false,
      messages: [{ id: "m1", role: "assistant", parts: [] }],
      error: null,
      submit: vi.fn(),
      stop: vi.fn(),
    };
  });

  it("marks its chat widget surface as web-managed", () => {
    renderThread();

    expect(screen.getByTestId("thread-web-managed").textContent).toBe("true");
  });
});
