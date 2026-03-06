import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fireEvent,
  mcpApiPresets,
  renderWithProviders,
  screen,
  setupMcpApiMock,
  storePresets,
} from "@/test";
import { useState } from "react";
import App from "../App";

const { mockUseAppState, mockMcpApi } = vi.hoisted(() => ({
  mockUseAppState: vi.fn(),
  mockMcpApi: {} as Record<string, unknown>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: () => ({ id: "user-1" }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: vi.fn(),
    signIn: vi.fn(),
    user: { id: "workos-user" },
    isLoading: false,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
}));

vi.mock("../hooks/usePostHogIdentify", () => ({
  usePostHogIdentify: () => {},
}));

vi.mock("../hooks/useElectronOAuth", () => ({
  useElectronOAuth: () => {},
}));

vi.mock("../hooks/useEnsureDbUser", () => ({
  useEnsureDbUser: () => {},
}));

vi.mock("../hooks/useViews", () => ({
  useViewQueries: () => ({ viewsByServer: new Map() }),
  useWorkspaceServers: () => ({ serversById: new Map() }),
}));

vi.mock("../hooks/hosted/use-hosted-api-context", () => ({
  useHostedApiContext: () => {},
}));

vi.mock("../hooks/useOrganizations", () => ({
  useOrganizationQueries: () => ({
    sortedOrganizations: [{ _id: "org-1", name: "Org" }],
    isLoading: false,
  }),
}));

vi.mock("../hooks/use-app-state", () => ({
  useAppState: mockUseAppState,
}));

vi.mock("../state/mcp-api", () => mockMcpApi);

vi.mock("../lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("../lib/hosted-navigation", () => ({
  resolveHostedNavigation: (target: string) => {
    const section = target.startsWith("#") ? target.slice(1) : target;
    const normalizedTab = section.includes(":")
      ? section.split(":")[0]
      : section;

    return {
      rawSection: section,
      normalizedSection: section,
      normalizedTab,
      isBlocked: false,
      organizationId: undefined,
      shouldSelectAllServers: false,
      shouldClearChatMessages: false,
    };
  },
}));

vi.mock("../lib/theme-utils", () => ({
  getInitialThemeMode: () => "dark",
  updateThemeMode: vi.fn(),
  getInitialThemePreset: () => "default",
  updateThemePreset: vi.fn(),
}));

vi.mock("../lib/PosthogUtils", () => ({
  detectEnvironment: () => "test",
  detectPlatform: () => "web",
}));

vi.mock("../lib/oauth/oauth-tokens", () => ({
  buildOAuthTokensByServerId: () => ({}),
}));

vi.mock("../lib/shared-server-session", () => ({
  clearSharedSignInReturnPath: vi.fn(),
  hasActiveSharedSession: () => false,
  readSharedServerSession: () => null,
  readSharedSignInReturnPath: () => null,
  slugify: (v: string) => v,
  SHARED_OAUTH_PENDING_KEY: "shared-oauth-pending",
  writeSharedSignInReturnPath: vi.fn(),
  readPendingServerAdd: () => null,
  clearPendingServerAdd: vi.fn(),
}));

vi.mock("../lib/oauth/mcp-oauth", () => ({
  handleOAuthCallback: vi.fn(),
}));

vi.mock("../components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-provider">{children}</div>
  ),
  SidebarInset: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-inset">{children}</div>
  ),
}));

vi.mock("../stores/preferences/preferences-provider", () => ({
  PreferencesStoreProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../state/app-state-context", () => ({
  AppStateProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../components/ui/sonner", () => ({
  Toaster: () => null,
}));

vi.mock("../components/Header", () => ({
  Header: () => <div data-testid="header" />,
}));

vi.mock("../components/organization/CreateOrganizationDialog", () => ({
  CreateOrganizationDialog: () => null,
}));

vi.mock("../components/hosted/HostedShellGate", () => ({
  HostedShellGate: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../components/hosted/hosted-shell-gate-state", () => ({
  resolveHostedShellGateState: () => ({
    allowed: true,
  }),
}));

vi.mock("../components/hosted/SharedServerChatPage", () => ({
  SharedServerChatPage: () => <div data-testid="shared-chat-page" />,
  getSharedPathTokenFromLocation: () => null,
}));

vi.mock("../components/LoadingScreen", () => ({
  default: () => <div data-testid="loading-screen" />,
}));

vi.mock("../components/CompletingSignInLoading", () => ({
  default: () => <div data-testid="completing-sign-in" />,
}));

vi.mock("../components/oauth/OAuthDebugCallback", () => ({
  default: () => <div data-testid="oauth-debug-callback" />,
}));

vi.mock("../components/ServersTab", () => ({
  ServersTab: () => <div data-testid="servers-tab" />,
}));

vi.mock("../components/EvalsTab", () => ({
  EvalsTab: () => <div data-testid="evals-tab" />,
}));

vi.mock("../components/ViewsTab", () => ({
  ViewsTab: () => <div data-testid="views-tab" />,
}));

vi.mock("../components/SkillsTab", () => ({
  SkillsTab: () => <div data-testid="skills-tab" />,
}));

vi.mock("../components/TasksTab", () => ({
  TasksTab: () => <div data-testid="tasks-tab" />,
}));

vi.mock("../components/AuthTab", () => ({
  AuthTab: () => <div data-testid="auth-tab" />,
}));

vi.mock("../components/OAuthFlowTab", () => ({
  OAuthFlowTab: () => <div data-testid="oauth-flow-tab" />,
}));

vi.mock("../components/ChatTabV2", () => ({
  ChatTabV2: () => <div data-testid="chat-v2-tab" />,
}));

vi.mock("../components/TracingTab", () => ({
  TracingTab: () => <div data-testid="tracing-tab" />,
}));

vi.mock("../components/SettingsTab", () => ({
  SettingsTab: () => <div data-testid="settings-tab" />,
}));

vi.mock("../components/SupportTab", () => ({
  SupportTab: () => <div data-testid="support-tab" />,
}));

vi.mock("../components/ProfileTab", () => ({
  ProfileTab: () => <div data-testid="profile-tab" />,
}));

vi.mock("../components/OrganizationsTab", () => ({
  OrganizationsTab: () => <div data-testid="organizations-tab" />,
}));

vi.mock("../components/ToolsTab", () => ({
  ToolsTab: () => {
    const [value, setValue] = useState("");
    return (
      <div data-testid="tools-tab">
        <input
          aria-label="tools-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
    );
  },
}));

vi.mock("../components/ResourcesTab", () => ({
  ResourcesTab: () => {
    const [value, setValue] = useState("");
    return (
      <div data-testid="resources-tab">
        <input
          aria-label="resources-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
    );
  },
}));

vi.mock("../components/PromptsTab", () => ({
  PromptsTab: () => {
    const [value, setValue] = useState("");
    return (
      <div data-testid="prompts-tab">
        <input
          aria-label="prompts-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
    );
  },
}));

vi.mock("../components/ui-playground/AppBuilderTab", () => ({
  AppBuilderTab: () => {
    const [value, setValue] = useState("");
    return (
      <div data-testid="app-builder-tab">
        <input
          aria-label="app-builder-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
    );
  },
}));

vi.mock("../components/mcp-sidebar", () => ({
  MCPSidebar: ({
    onNavigate,
  }: {
    onNavigate?: (tab: string) => void;
    activeTab?: string;
    servers?: Record<string, unknown>;
  }) => (
    <div data-testid="mock-sidebar">
      <button onClick={() => onNavigate?.("servers")}>servers</button>
      <button onClick={() => onNavigate?.("tools")}>tools</button>
      <button onClick={() => onNavigate?.("resources")}>resources</button>
      <button onClick={() => onNavigate?.("prompts")}>prompts</button>
      <button onClick={() => onNavigate?.("app-builder")}>app-builder</button>
    </div>
  ),
}));

describe("App tab keep-alive", () => {
  beforeEach(() => {
    (globalThis as any).__APP_VERSION__ = "test";
    window.history.replaceState({}, "", "/");

    Object.assign(mockMcpApi, setupMcpApiMock(mcpApiPresets.allSuccess()));
    mockUseAppState.mockReturnValue(storePresets.singleConnected("server-1"));
  });

  it("preserves Tools state when switching to App Builder and back", () => {
    renderWithProviders(<App />);

    fireEvent.click(screen.getByRole("button", { name: "tools" }));
    const toolsInput = screen.getByLabelText("tools-input");
    fireEvent.change(toolsInput, { target: { value: "weather=nyc" } });

    fireEvent.click(screen.getByRole("button", { name: "app-builder" }));
    expect(screen.getByTestId("app-builder-tab")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "tools" }));
    expect(screen.getByLabelText("tools-input")).toHaveValue("weather=nyc");
  });

  it("preserves Resources and Prompts local state across tab switches", () => {
    renderWithProviders(<App />);

    fireEvent.click(screen.getByRole("button", { name: "resources" }));
    fireEvent.change(screen.getByLabelText("resources-input"), {
      target: { value: "uri=docs://intro" },
    });

    fireEvent.click(screen.getByRole("button", { name: "prompts" }));
    fireEvent.change(screen.getByLabelText("prompts-input"), {
      target: { value: "topic=onboarding" },
    });

    fireEvent.click(screen.getByRole("button", { name: "resources" }));
    expect(screen.getByLabelText("resources-input")).toHaveValue(
      "uri=docs://intro",
    );

    fireEvent.click(screen.getByRole("button", { name: "prompts" }));
    expect(screen.getByLabelText("prompts-input")).toHaveValue(
      "topic=onboarding",
    );
  });
});
