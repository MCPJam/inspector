import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ResourcesTab } from "../ResourcesTab";
import { PromptsTab } from "../PromptsTab";
import {
  registerAuthChallengeHostProfile,
  useAuthChallengeCardStore,
} from "@/lib/auth-challenge-lifecycle";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/state/app-types";

const mockListResources = vi.fn();
const mockReadResource = vi.fn();
vi.mock("@/lib/apis/mcp-resources-api", () => ({
  listResources: (...args: unknown[]) => mockListResources(...args),
  readResource: (...args: unknown[]) => mockReadResource(...args),
}));

const mockListPrompts = vi.fn();
const mockGetPrompt = vi.fn();
vi.mock("@/lib/apis/mcp-prompts-api", () => ({
  listPrompts: (...args: unknown[]) => mockListPrompts(...args),
  getPrompt: (...args: unknown[]) => mockGetPrompt(...args),
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div />,
}));
vi.mock("../logger-view", () => ({ LoggerView: () => <div /> }));
vi.mock("@mcpjam/design-system/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const serverConfig = {
  type: "http",
  url: "https://orders.example/mcp",
} as unknown as MCPServerConfig;
const server = {
  name: "orders",
  config: serverConfig,
  useOAuth: false,
} as unknown as ServerWithName;

const SIGNAL = {
  source: "http_401",
  errorDescription: "Sign in to see orders",
  effectiveAuth: "discover",
  facets: {
    challengeHeader: "bearer",
    hasResourceMetadata: false,
    hasScope: false,
    hasErrorParams: false,
  },
};
const REFUSAL =
  "The call failed because the server requires sign-in. The server said: Sign in to see orders. Change Mid-session sign-in in Connect settings.";

/**
 * A call the server refuses with a sign-in challenge: the API reports the
 * challenge, then throws the transport error that carries it.
 */
function challengedCall(...args: unknown[]) {
  const options = args.at(-1) as {
    onAuthChallenge?: (signal: unknown) => void;
  };
  options.onAuthChallenge?.(SIGNAL);
  return Promise.reject(
    Object.assign(new Error("HTTP 401 Unauthorized"), {
      details: { authChallenge: SIGNAL },
    }),
  );
}

describe("mid-session sign-in on resources and prompts", () => {
  let unregister: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    useAuthChallengeCardStore.setState({ cards: {} });
    mockListResources.mockResolvedValue({
      resources: [{ name: "orders.json", uri: "orders://recent" }],
    });
    mockReadResource.mockImplementation(challengedCall);
    mockListPrompts.mockResolvedValue([{ name: "recent-orders" }]);
    mockGetPrompt.mockImplementation(challengedCall);
  });

  afterEach(() => unregister?.());

  async function readResource() {
    render(
      <ResourcesTab
        serverConfig={serverConfig}
        serverName="orders"
        server={server}
      />,
    );
    fireEvent.click(await screen.findByText("orders.json"));
    await waitFor(() => expect(mockReadResource).toHaveBeenCalled());
  }

  async function getPrompt() {
    render(
      <PromptsTab
        serverConfig={serverConfig}
        serverName="orders"
        server={server}
      />,
    );
    fireEvent.click(await screen.findByText("recent-orders"));
    await waitFor(() => expect(mockGetPrompt).toHaveBeenCalled());
  }

  it.each([
    ["resource read", readResource],
    ["prompt", getPrompt],
  ])("a %s shows the Connect card without the raw 401", async (_l, run) => {
    await run();
    await screen.findByTestId("auth-challenge-card");
    expect(screen.queryByText(/HTTP 401 Unauthorized/)).toBeNull();
  });

  it("does not leave the previous resource's content under the card", async () => {
    mockListResources.mockResolvedValue({
      resources: [
        { name: "menu.json", uri: "menu://today" },
        { name: "orders.json", uri: "orders://recent" },
      ],
    });
    mockReadResource.mockImplementation((...args: unknown[]) =>
      args[1] === "menu://today"
        ? Promise.resolve({
            content: { contents: [{ type: "text", text: "Today's menu" }] },
          })
        : challengedCall(...args),
    );
    render(
      <ResourcesTab
        serverConfig={serverConfig}
        serverName="orders"
        server={server}
      />,
    );
    fireEvent.click(await screen.findByText("menu.json"));
    expect(await screen.findByText(/Today's menu/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("orders.json"));
    await screen.findByTestId("auth-challenge-card");
    expect(screen.queryByText(/Today's menu/)).toBeNull();
  });

  it("keeps the raw error when there is no server to show a card for", async () => {
    render(<ResourcesTab serverConfig={serverConfig} serverName="orders" />);
    fireEvent.click(await screen.findByText("orders.json"));
    expect(
      await screen.findByText(
        /Error reading resource: .*HTTP 401 Unauthorized/,
      ),
    ).toBeInTheDocument();
  });

  it.each([
    ["resource read", readResource],
    ["prompt", getPrompt],
  ])(
    "a %s stays failed when the selected host passes the 401 through",
    async (_l, run) => {
      unregister = registerAuthChallengeHostProfile(() => ({
        unauthorizedChallenge: "passthrough",
      }));
      await run();
      await screen.findByTestId("auth-challenge-notice");
      expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
      expect(screen.queryByText(/HTTP 401 Unauthorized/)).toBeNull();
      expect(screen.queryByTestId("auth-challenge-card")).toBeNull();
    },
  );
});
