import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ServerWithName } from "@/hooks/use-app-state";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: vi.fn().mockResolvedValue({ tools: [], toolsMetadata: {} }),
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  isMCPApp: () => false,
  isOpenAIApp: () => false,
  isOpenAIAppAndMCPApp: () => false,
}));

import { ServerDetailModal } from "../ServerDetailModal";

function createServer(
  overrides: Partial<ServerWithName> = {},
): ServerWithName {
  return {
    name: "test-server",
    lastConnectionTime: new Date(),
    connectionStatus: "disconnected",
    enabled: true,
    retryCount: 0,
    useOAuth: false,
    config: {
      url: "https://example.com/mcp",
    },
    ...overrides,
  };
}

describe("ServerDetailModal hosted reconnect", () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    server: createServer(),
    defaultTab: "configuration" as const,
    onSubmit: vi.fn().mockResolvedValue({
      ok: true,
      serverName: "test-server",
    }),
    onDisconnect: vi.fn(),
    onReconnect: vi.fn().mockResolvedValue(undefined),
    existingServerNames: ["test-server"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("allows interactive OAuth reconnect for OAuth servers without tokens", () => {
    const onReconnect = vi.fn().mockResolvedValue(undefined);

    render(
      <ServerDetailModal
        {...defaultProps}
        server={createServer({ useOAuth: true })}
        onReconnect={onReconnect}
      />,
    );

    fireEvent.click(screen.getByRole("switch"));

    expect(onReconnect).toHaveBeenCalledWith("test-server", {
      allowInteractiveOAuthFlow: true,
    });
  });
});
