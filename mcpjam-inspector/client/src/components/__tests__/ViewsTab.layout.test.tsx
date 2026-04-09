import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ViewsTab } from "../ViewsTab";

const {
  mockUseViewQueries,
  mockUseWorkspaceServers,
  mockCapture,
  mockCurrentDisplayContext,
  mockPlaygroundStoreState,
  mockViewMutations,
} = vi.hoisted(() => ({
  mockUseViewQueries: vi.fn(),
  mockUseWorkspaceServers: vi.fn(),
  mockCapture: vi.fn(),
  mockCurrentDisplayContext: vi.fn(() => ({
    theme: "dark",
    displayMode: "inline",
    deviceType: "desktop",
    locale: "en-US",
    timeZone: "UTC",
    capabilities: { hover: true, touch: false },
    safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
  })),
  mockPlaygroundStoreState: {
    setSelectedProtocol: vi.fn(),
    setDeviceType: vi.fn(),
    setCustomViewport: vi.fn(),
    updateGlobal: vi.fn(),
    setCapabilities: vi.fn(),
    setSafeAreaInsets: vi.fn(),
  },
  mockViewMutations: {
    createMcpView: vi.fn(),
    createOpenaiView: vi.fn(),
    updateMcpView: vi.fn(),
    updateOpenaiView: vi.fn(),
    removeMcpView: vi.fn(),
    removeOpenaiView: vi.fn(),
    generateMcpUploadUrl: vi.fn(),
    generateOpenaiUploadUrl: vi.fn(),
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: mockCapture,
  }),
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn(() => "test"),
  detectPlatform: vi.fn(() => "web"),
}));

vi.mock("@/hooks/useViews", () => ({
  useViewQueries: (...args: unknown[]) => mockUseViewQueries(...args),
  useWorkspaceServers: (...args: unknown[]) => mockUseWorkspaceServers(...args),
  useViewMutations: () => mockViewMutations,
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({
    workspaces: {
      "workspace-1": {
        sharedWorkspaceId: "workspace-1",
      },
    },
    activeWorkspaceId: "workspace-1",
    servers: {
      "selected-server": {
        connectionStatus: "connected",
      },
    },
  }),
}));

vi.mock("@/lib/display-context-utils", () => ({
  useCurrentDisplayContext: () => mockCurrentDisplayContext(),
  areDisplayContextsEqual: (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b),
}));

vi.mock("@/stores/widget-debug-store", () => ({
  useWidgetDebugStore: (
    selector: (state: { widgets: Map<string, unknown> }) => unknown,
  ) => selector({ widgets: new Map() }),
}));

vi.mock("@/stores/ui-playground-store", () => ({
  useUIPlaygroundStore: (
    selector: (state: typeof mockPlaygroundStoreState) => unknown,
  ) => selector(mockPlaygroundStoreState),
}));

vi.mock("../ui-playground/PlaygroundMain", () => ({
  PlaygroundMain: () => <div data-testid="playground-main" />,
}));

vi.mock("../views/ViewEditorPanel", () => ({
  ViewEditorPanel: () => <div data-testid="view-editor-panel" />,
}));

const INVALID_LAYOUT_TOTAL_MESSAGE = "Invalid layout total size";

function hasConsoleMessage(spy: ReturnType<typeof vi.spyOn>, message: string) {
  return spy.mock.calls.some((call) =>
    call.some((arg) => typeof arg === "string" && arg.includes(message)),
  );
}

describe("ViewsTab layout", () => {
  beforeEach(() => {
    localStorage.clear();
    mockUseViewQueries.mockReset();
    mockUseWorkspaceServers.mockReset();
    mockCapture.mockReset();
    mockCurrentDisplayContext.mockClear();
    Object.values(mockPlaygroundStoreState).forEach((value) => {
      if (typeof value === "function" && "mockClear" in value) {
        value.mockClear();
      }
    });
    Object.values(mockViewMutations).forEach((value) => value.mockClear());

    mockUseViewQueries.mockReturnValue({
      sortedViews: [],
      isLoading: false,
    });
    mockUseWorkspaceServers.mockReturnValue({
      serversById: new Map(),
      serversByName: new Map([["selected-server", "server-1"]]),
    });
  });

  it("renders with valid panel defaults when the Views tab mounts", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() =>
        render(<ViewsTab selectedServer="selected-server" />),
      ).not.toThrow();

      expect(screen.getByText("Views")).toBeInTheDocument();
      expect(screen.getByText("No views yet")).toBeInTheDocument();
      expect(screen.getByText("No views for this server")).toBeInTheDocument();
      expect(hasConsoleMessage(warnSpy, INVALID_LAYOUT_TOTAL_MESSAGE)).toBe(
        false,
      );
      expect(hasConsoleMessage(errorSpy, INVALID_LAYOUT_TOTAL_MESSAGE)).toBe(
        false,
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
