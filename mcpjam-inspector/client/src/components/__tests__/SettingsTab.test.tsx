import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsTab } from "../SettingsTab";

vi.stubGlobal("__APP_VERSION__", "0.0.0-test");

// Mock hooks used by SettingsTab
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) =>
    selector({ themeMode: "light", setThemeMode: vi.fn() }),
}));

vi.mock("@/hooks/use-ai-provider-keys", () => ({
  useAiProviderKeys: () => ({
    tokens: {},
    setToken: vi.fn(),
    clearToken: vi.fn(),
    hasToken: vi.fn(() => false),
    getOllamaBaseUrl: vi.fn(() => ""),
    setOllamaBaseUrl: vi.fn(),
    getOpenRouterSelectedModels: vi.fn(() => []),
    setOpenRouterSelectedModels: vi.fn(),
    getAzureBaseUrl: vi.fn(() => ""),
    setAzureBaseUrl: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-custom-providers", () => ({
  useCustomProviders: () => ({
    customProviders: [],
    addCustomProvider: vi.fn(),
    updateCustomProvider: vi.fn(),
    removeCustomProvider: vi.fn(),
  }),
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

// Mock AccountApiKeySection since it uses Convex hooks directly
vi.mock("../setting/AccountApiKeySection", () => ({
  AccountApiKeySection: ({
    workspaceName,
  }: {
    workspaceId: string | null;
    workspaceName: string | null;
  }) => (
    <div data-testid="account-api-key-section">
      API Key: {workspaceName}
    </div>
  ),
}));

describe("SettingsTab", () => {
  const defaultProps = {
    convexWorkspaceId: "workspace-123",
    workspaceName: "My Workspace",
    activeWorkspaceId: "ws-local-1",
    onUpdateWorkspace: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders workspace name in the settings", () => {
    render(<SettingsTab {...defaultProps} />);

    expect(screen.getByText("My Workspace")).toBeInTheDocument();
  });

  it("renders the Name label in the Workspace section", () => {
    render(<SettingsTab {...defaultProps} />);

    expect(screen.getByText("Name")).toBeInTheDocument();
  });

  it("enters edit mode when workspace name is clicked", () => {
    render(<SettingsTab {...defaultProps} />);

    fireEvent.click(screen.getByText("My Workspace"));

    const input = screen.getByDisplayValue("My Workspace");
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe("INPUT");
  });

  it("calls onUpdateWorkspace with new name on save", async () => {
    render(<SettingsTab {...defaultProps} />);

    // Click to enter edit mode
    fireEvent.click(screen.getByText("My Workspace"));

    const input = screen.getByDisplayValue("My Workspace");
    fireEvent.change(input, { target: { value: "Renamed Workspace" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(defaultProps.onUpdateWorkspace).toHaveBeenCalledWith(
        "ws-local-1",
        { name: "Renamed Workspace" },
      );
    });
  });

  it("does not call onUpdateWorkspace when name is unchanged", async () => {
    render(<SettingsTab {...defaultProps} />);

    fireEvent.click(screen.getByText("My Workspace"));

    const input = screen.getByDisplayValue("My Workspace");
    fireEvent.keyDown(input, { key: "Enter" });

    // Small wait to ensure no call happens
    await new Promise((r) => setTimeout(r, 50));
    expect(defaultProps.onUpdateWorkspace).not.toHaveBeenCalled();
  });

  it("cancels editing on Escape without saving", async () => {
    render(<SettingsTab {...defaultProps} />);

    fireEvent.click(screen.getByText("My Workspace"));

    const input = screen.getByDisplayValue("My Workspace");
    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(defaultProps.onUpdateWorkspace).not.toHaveBeenCalled();
    expect(screen.getByText("My Workspace")).toBeInTheDocument();
  });
});
