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

vi.mock("@/lib/analytics", () => ({
  track: vi.fn(),
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  hasOAuthConfig: vi.fn().mockReturnValue(false),
}));

vi.mock("../connection/AddServerModal", () => ({
  AddServerModal: () => null,
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
  onReconnect: vi.fn().mockResolvedValue(undefined),
};

describe("ActiveServerSelector hosted reconnect guard", () => {
  it("disables reconnect for hosted non-HTTPS servers", () => {
    const onReconnect = vi.fn().mockResolvedValue(undefined);
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

  it("disables reconnect for a hosted stdio server too", () => {
    // The guard used to be `http://`-only, so a legacy stdio row in a
    // hosted project kept a live Reconnect button that could only ever
    // fail — the cloud has no local process to spawn. Rows like this
    // predate hosted mode's block on CREATING stdio servers.
    const onReconnect = vi.fn().mockResolvedValue(undefined);
    render(
      <ActiveServerSelector
        {...defaultProps}
        onReconnect={onReconnect}
        serverConfigs={{
          "legacy-stdio": createServer({
            name: "legacy-stdio",
            config: { command: "npx", args: ["-y", "some-server"] } as any,
          }),
        }}
      />,
    );

    const row = screen.getByText("legacy-stdio").closest("button");
    if (!row) {
      throw new Error("Server row not found");
    }
    const reconnect = within(row).getByTitle(
      "STDIO servers run a local command, which the cloud deployment cannot do. Run MCPJam locally to connect this server.",
    );
    expect(reconnect).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(reconnect);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("keeps reconnect enabled for hosted HTTPS servers", () => {
    const onReconnect = vi.fn().mockResolvedValue(undefined);
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
