import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsTab } from "../SettingsTab";

vi.stubGlobal("__APP_VERSION__", "0.0.0-test");

const { mockSetThemeMode, mockUpdateThemeMode } = vi.hoisted(() => ({
  mockSetThemeMode: vi.fn(),
  mockUpdateThemeMode: vi.fn(),
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) =>
    selector({ themeMode: "light", setThemeMode: mockSetThemeMode }),
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

vi.mock("@/lib/theme-utils", () => ({
  updateThemeMode: mockUpdateThemeMode,
}));

describe("SettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders settings heading and version info", () => {
    render(<SettingsTab />);

    expect(
      screen.getByRole("heading", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(screen.getByText("About")).toBeInTheDocument();
    expect(screen.getByText("Version")).toBeInTheDocument();
    expect(screen.getByText("v0.0.0-test")).toBeInTheDocument();
  });

  it("renders appearance controls in hosted mode", () => {
    render(<SettingsTab />);

    expect(screen.getByText("Appearance")).toBeInTheDocument();
    expect(screen.getByText("Theme")).toBeInTheDocument();
    expect(screen.getByText("Light")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Toggle dark mode" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("LLM Providers")).not.toBeInTheDocument();
  });

  it("updates theme when toggled", async () => {
    render(<SettingsTab />);

    fireEvent.click(screen.getByRole("switch", { name: "Toggle dark mode" }));

    await waitFor(() => {
      expect(mockUpdateThemeMode).toHaveBeenCalledWith("dark");
      expect(mockSetThemeMode).toHaveBeenCalledWith("dark");
    });
  });
});
