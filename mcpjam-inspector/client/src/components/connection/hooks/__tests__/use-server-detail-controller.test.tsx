import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { listTools } from "@/lib/apis/mcp-tools-api";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  createConnectedServer,
  createHttpServerConfig,
  createServer,
} from "@/test/factories";
import { track } from "@/lib/analytics";
import {
  useServerDetailController,
  type ServerDetailController,
  type ServerDetailControllerOptions,
} from "../use-server-detail-controller";

const settingsFixture = vi.hoisted(() => ({ available: false }));
const mockToastConnectionFailure = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockReportCaught = vi.hoisted(() => vi.fn());
const mockFetchServerSecrets = vi.hoisted(() => vi.fn());

vi.mock("../../../host-workspace/use-server-settings", () => ({
  useServerSettingsAvailability: (scope: unknown) => ({
    available: !!scope && settingsFixture.available,
    failed: false,
    retry: vi.fn(),
  }),
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { email: "tester@example.com" } }),
}));
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
  useFeatureFlagEnabled: () => false,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));
vi.mock("@/lib/server-error-toast", () => ({
  toastServerConnectionFailure: mockToastConnectionFailure,
}));
vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: vi.fn().mockResolvedValue({ tools: [], toolsMetadata: {} }),
}));
vi.mock("@/lib/toast", () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));
vi.mock("@/lib/error-reporting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/error-reporting")>()),
  reportCaught: mockReportCaught,
}));
vi.mock("@/lib/apis/server-secrets-api", () => ({
  fetchServerSecretKeys: vi
    .fn()
    .mockResolvedValue({ envKeys: [], headerKeys: [] }),
  fetchServerSecrets: mockFetchServerSecrets,
}));

const SETTINGS_SCOPE = {
  projectId: "project",
  hostId: "host",
  threadId: "thread",
  pluginWorkspace: { version: 1 as const, workspaceId: "workspace" },
};

function httpServer(overrides: Partial<ServerWithName> = {}): ServerWithName {
  return createConnectedServer({
    name: "linear",
    config: createHttpServerConfig("https://example.com/mcp"),
    ...overrides,
  });
}

/**
 * Renders the controller inside a form, the way the modal does, so the
 * configuration submit goes through a real submit event.
 */
function renderController(overrides: Partial<ServerDetailControllerOptions>) {
  const options: ServerDetailControllerOptions = {
    isOpen: true,
    server: httpServer(),
    onSubmit: vi.fn().mockResolvedValue({ ok: true, serverName: "linear" }),
    onDisconnect: vi.fn(),
    onReconnect: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    existingServerNames: ["linear", "github"],
    ...overrides,
  };
  const latest: { current: ServerDetailController | null } = { current: null };
  function Harness() {
    const controller = useServerDetailController(options);
    latest.current = controller;
    return <form data-testid="config-form" onSubmit={controller.form.submit} />;
  }
  render(<Harness />);
  const controller = () => {
    if (!latest.current) throw new Error("controller did not render");
    return latest.current;
  };
  return { options, controller };
}

describe("useServerDetailController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsFixture.available = false;
  });

  it("opens on Config and mounts Settings only once that tab is chosen", () => {
    settingsFixture.available = true;
    const { controller } = renderController({
      hostedServerId: "server_1",
      extensionSettingsScope: SETTINGS_SCOPE,
    });
    expect(controller().tabs.active).toBe("configuration");
    expect(controller().settings.showBody).toBe(false);

    act(() => controller().tabs.select("settings"));
    expect(controller().tabs.active).toBe("settings");
    expect(controller().settings.showBody).toBe(true);

    // Leaving Settings keeps its body mounted.
    act(() => controller().tabs.select("overview"));
    expect(controller().settings.showBody).toBe(true);
  });

  it("opens on the deep-linked tab", () => {
    const { controller } = renderController({ defaultTab: "compatibility" });
    expect(controller().tabs.active).toBe("compatibility");
  });

  it("lets a caller that owns the tab drive it", () => {
    settingsFixture.available = true;
    const onTabChange = vi.fn();
    const { controller } = renderController({
      activeTab: "settings",
      onTabChange,
      hostedServerId: "server_1",
      extensionSettingsScope: SETTINGS_SCOPE,
    });
    expect(controller().tabs.active).toBe("settings");
    expect(controller().settings.showBody).toBe(true);

    act(() => controller().tabs.select("history"));
    expect(onTabChange).toHaveBeenCalledWith("history");
    // The caller has not moved the tab yet, so it stays put.
    expect(controller().tabs.active).toBe("settings");
  });

  it("records where the details were shown", async () => {
    const { controller } = renderController({
      analyticsLocation: "server_canvas",
    });
    await act(() => controller().connection.connect());
    expect(track).toHaveBeenCalledWith(
      "server_detail_modal_connect_clicked",
      expect.objectContaining({ location: "server_canvas" }),
    );
  });

  it("lists Auth only for HTTP servers and History only for a saved project server", () => {
    const stdio = renderController({
      server: createServer({ name: "local", connectionStatus: "connected" }),
    });
    expect(stdio.controller().tabs.visible.map((tab) => tab.id)).toEqual([
      "configuration",
      "overview",
      "tools-metadata",
      "compatibility",
    ]);

    const saved = renderController({
      projectId: "project_1",
      hostedServerId: "server_1",
    });
    expect(saved.controller().tabs.visible.map((tab) => tab.id)).toEqual([
      "configuration",
      "overview",
      "tools-metadata",
      "authorization",
      "compatibility",
      "history",
    ]);
  });

  it("saves the configuration through onSubmit, only from the Config tab", async () => {
    const { options, controller } = renderController({});
    fireEvent.submit(screen.getByTestId("config-form"));
    await waitFor(() => expect(options.onSubmit).toHaveBeenCalledTimes(1));
    expect(options.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "linear" }),
      "linear",
    );
    await waitFor(() => expect(controller().form.isSaving).toBe(false));

    act(() => controller().tabs.select("overview"));
    fireEvent.submit(screen.getByTestId("config-form"));
    expect(options.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("blocks saving under a name another server already uses", () => {
    const { options, controller } = renderController({});
    act(() => controller().form.state.setName("github"));
    expect(controller().form.isDuplicateServerName).toBe(true);
    expect(controller().form.saveBlocked).toBe(true);

    fireEvent.submit(screen.getByTestId("config-form"));
    expect(options.onSubmit).not.toHaveBeenCalled();
  });

  it("saves a URL moved to another host without blocking Save", async () => {
    const { options, controller } = renderController({});
    act(() =>
      controller().form.state.setUrl("https://example.com:8443/mcp"),
    );
    expect(controller().form.saveBlocked).toBe(false);

    fireEvent.submit(screen.getByTestId("config-form"));
    await waitFor(() => expect(options.onSubmit).toHaveBeenCalledTimes(1));
    expect(options.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com:8443/mcp" }),
      "linear",
    );
  });

  it("offers Reconnect for a connected server with no edits", () => {
    const { controller } = renderController({});
    expect(controller().form.offersReconnect).toBe(true);
  });

  it("connects through the interactive OAuth flow when the server has no tokens", async () => {
    const { options, controller } = renderController({
      server: httpServer({
        connectionStatus: "disconnected",
        useOAuth: true,
        oauthTokens: undefined,
      }),
    });
    act(() => controller().connection.toggle(true));
    await waitFor(() =>
      expect(options.onReconnect).toHaveBeenCalledWith("linear", {
        allowInteractiveOAuthFlow: true,
      }),
    );

    act(() => controller().connection.toggle(false));
    expect(options.onDisconnect).toHaveBeenCalledWith("linear");
  });

  it("tells the user a connect failed and clears the in-flight state", async () => {
    const { controller } = renderController({
      onReconnect: vi.fn().mockRejectedValue(new Error("refused")),
    });
    await act(() => controller().connection.connect());
    expect(mockToastConnectionFailure).toHaveBeenCalledWith(
      "linear",
      "refused",
    );
    expect(controller().connection.isReconnecting).toBe(false);
  });

  it("runs the OAuth flow for a connection account and reconnects after a switch", async () => {
    const { options, controller } = renderController({});
    await act(() => controller().auth.authenticate({ kind: "add" }));
    expect(options.onReconnect).toHaveBeenCalledWith("linear", {
      forceOAuthFlow: true,
      connectionIntent: { kind: "add" },
    });

    await act(() => controller().auth.switchAccount());
    expect(options.onReconnect).toHaveBeenLastCalledWith("linear", {
      allowInteractiveOAuthFlow: false,
    });
  });

  it.each([
    ["a non-Error", { code: 500 }],
    ["an empty-string", ""],
  ])(
    "fails the tools load with a message after %s rejection",
    async (_label, rejection) => {
      vi.mocked(listTools).mockRejectedValueOnce(rejection);
      const { controller } = renderController({});
      await waitFor(() => expect(controller().tools.status).toBe("failed"));
      expect(controller().tools.error).toBe(
        "The server gave no reason. Check it and reconnect.",
      );
    },
  );

  it("keeps a tools load failure's own message", async () => {
    vi.mocked(listTools).mockRejectedValueOnce(
      new Error("tools/list timed out"),
    );
    const { controller } = renderController({});
    await waitFor(() => expect(controller().tools.status).toBe("failed"));
    expect(controller().tools.error).toBe("tools/list timed out");
  });

  it("reports a failed saved-headers read, tells the user and does not save", async () => {
    mockFetchServerSecrets.mockRejectedValueOnce(
      new Error("vault unavailable"),
    );
    const { options, controller } = renderController({
      projectId: "project_1",
      hostedServerId: "server_1",
      server: httpServer({ hasHeaders: true }),
    });
    await waitFor(() =>
      expect(controller().form.state.hasStoredHeaders).toBe(true),
    );
    act(() => {
      controller().form.state.setAuthType("bearer");
      controller().form.state.setBearerToken("new-token");
    });
    expect(controller().form.state.needsStoredHeaderReveal).toBe(true);

    await act(() => controller().form.save());
    expect(mockFetchServerSecrets).toHaveBeenCalledWith({
      projectId: "project_1",
      serverId: "server_1",
    });
    expect(mockReportCaught).toHaveBeenCalledWith(
      expect.objectContaining({ message: "vault unavailable" }),
      expect.objectContaining({ source: "server_detail_save_reveal_headers" }),
    );
    expect(mockToastError).toHaveBeenCalledWith(
      "Couldn't load this server's saved headers to apply this change. Reveal saved headers in Advanced settings and try again.",
    );
    expect(options.onSubmit).not.toHaveBeenCalled();
    expect(controller().form.isSaving).toBe(false);
  });
});
