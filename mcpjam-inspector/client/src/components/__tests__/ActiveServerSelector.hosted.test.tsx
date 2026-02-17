import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  ActiveServerSelector,
  type ActiveServerSelectorProps,
} from "../ActiveServerSelector";
import type { ServerWithName } from "@/hooks/use-app-state";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn().mockReturnValue("test"),
  detectPlatform: vi.fn().mockReturnValue("web"),
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  hasOAuthConfig: vi.fn().mockReturnValue(false),
}));

vi.mock("../connection/AddServerModal", () => ({
  AddServerModal: () => null,
}));

vi.mock("../chat-v2/chat-input/dialogs/confirm-chat-reset-dialog", () => ({
  ConfirmChatResetDialog: () => null,
}));

const HOSTED_HINT =
  "Hosted mode requires HTTPS server URLs. Edit this server to use https://.";

const createServer = (
  overrides: Partial<ServerWithName> = {},
): ServerWithName =>
  ({
    name: "test-server",
    connectionStatus: "disconnected",
    enabled: true,
    retryCount: 0,
    useOAuth: false,
    config: {
      transportType: "streamableHttp",
      url: "https://example.com/mcp",
    },
    ...overrides,
  }) as ServerWithName;

const defaultProps: ActiveServerSelectorProps = {
  serverConfigs: {},
  selectedServer: "",
  selectedMultipleServers: [],
  isMultiSelectEnabled: false,
  onServerChange: vi.fn(),
  onMultiServerToggle: vi.fn(),
  onConnect: vi.fn(),
  onReconnect: vi.fn(),
};

describe("ActiveServerSelector hosted reconnect guard", () => {
  it("disables reconnect for hosted non-HTTPS servers", () => {
    const onReconnect = vi.fn();
    render(
      <ActiveServerSelector
        {...defaultProps}
        onReconnect={onReconnect}
        serverConfigs={{
          insecure: createServer({
            name: "insecure",
            config: {
              transportType: "streamableHttp",
              url: "http://example.com/mcp",
            },
          }),
        }}
      />,
    );

    const row = screen.getByText("insecure").closest("button");
    if (!row) {
      throw new Error("Server row not found");
    }
    const reconnect = within(row).getByTitle(HOSTED_HINT);
    expect(reconnect).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(reconnect);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("keeps reconnect enabled for hosted HTTPS servers", () => {
    const onReconnect = vi.fn();
    render(
      <ActiveServerSelector
        {...defaultProps}
        onReconnect={onReconnect}
        serverConfigs={{
          secure: createServer({ name: "secure" }),
        }}
      />,
    );

    const row = screen.getByText("secure").closest("button");
    if (!row) {
      throw new Error("Server row not found");
    }
    const reconnect = within(row).getByTitle("Reconnect");

    fireEvent.click(reconnect);
    expect(onReconnect).toHaveBeenCalledWith("secure");
  });
});
