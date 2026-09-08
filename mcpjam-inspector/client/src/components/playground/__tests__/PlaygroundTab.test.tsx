import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import { render, screen } from "@testing-library/react";

// PlaygroundTab pulls in a large hook + provider graph. We only care about the
// `loadingState` branch that decides whether the branded first-run loading
// screen shows, so neutralize everything else and drive `loadingState`.

const mockLoadingScreen = vi.hoisted(() => vi.fn());
const mockLoadingState = vi.hoisted(() => ({
  current: { kind: "skeleton" } as { kind: string },
}));

vi.mock("@/components/LoadingScreen", () => ({
  default: (props: { message?: string }) => {
    mockLoadingScreen(props);
    return <div data-testid="loading-screen">{props.message ?? ""}</div>;
  },
}));

vi.mock("@/components/ui-playground/hooks/use-playground-state", () => ({
  usePlaygroundState: () => ({ loadingState: mockLoadingState.current }),
  PlaygroundStateProvider: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: false }),
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ themeMode: "light" }),
}));
vi.mock("@/hooks/useClients", () => ({ useHost: () => ({ host: null }) }));
vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => [null, vi.fn()],
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({ servers: [] }),
}));
vi.mock("@/hooks/useAutoConnectProjectServers", () => ({
  useAutoConnectProjectServers: () => {},
}));
vi.mock("@/lib/scenario-client-style", () => ({
  getScenarioShellStyle: () => ({}),
}));
vi.mock("@/lib/client-config-v2", () => ({
  gateMcpToolResultImageRenderingByModelVisibility: () => undefined,
}));

// The non-skeleton branch renders a deep provider/panel tree; stub each piece
// to a trivial passthrough so a "ready" render doesn't need the whole app.
vi.mock("@/contexts/scenario-client-style-context", () => ({
  ScenarioChatUiOverrideProvider: ({ children }: { children?: ReactNode }) =>
    children,
  ScenarioHostStyleProvider: ({ children }: { children?: ReactNode }) =>
    children,
  ScenarioHostThemeProvider: ({ children }: { children?: ReactNode }) =>
    children,
}));
vi.mock("@/contexts/scenario-client-capabilities-override-context", () => ({
  ScenarioHostCapabilitiesOverrideProvider: ({
    children,
  }: {
    children?: ReactNode;
  }) => children,
}));
vi.mock("@/contexts/active-mcp-profile-context", () => ({
  ActiveMcpProfileProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/contexts/active-host-client-capabilities-context", () => ({
  ActiveHostCapsResolverScope: ({ children }: { children?: ReactNode }) =>
    children,
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children?: ReactNode }) => children,
  ResizablePanel: ({ children }: { children?: ReactNode }) => children,
  ResizableHandle: () => null,
}));
vi.mock("@/components/ui/collapsed-panel-strip", () => ({
  CollapsedPanelStrip: () => null,
}));
vi.mock("@/components/playground/PlaygroundRightRail", () => ({
  PlaygroundRightRail: () => null,
}));
// Relative to PlaygroundTab.tsx, so "../X" from this __tests__ dir resolves to
// the same module the source imports as "./X".
vi.mock("../PlaygroundCenter", () => ({
  PlaygroundCenter: () => <div data-testid="playground-center" />,
}));
vi.mock("../PlaygroundPreviewedClientSync", () => ({
  PlaygroundPreviewedClientSync: () => null,
}));
vi.mock("../PlaygroundLeftRail", () => ({
  PlaygroundLeftRail: () => null,
}));

import { PlaygroundTab } from "../PlaygroundTab";

// isWorkOsAuthLoading:true short-circuits the one-time view-tracking effect.
const baseProps: ComponentProps<typeof PlaygroundTab> = {
  isWorkOsAuthLoading: true,
};

describe("PlaygroundTab loading branch", () => {
  beforeEach(() => {
    mockLoadingScreen.mockClear();
    mockLoadingState.current = { kind: "skeleton" };
  });

  it("shows the branded 'Setting things up...' screen during the first-run skeleton", () => {
    mockLoadingState.current = { kind: "skeleton" };

    render(<PlaygroundTab {...baseProps} />);

    expect(mockLoadingScreen).toHaveBeenCalledTimes(1);
    expect(mockLoadingScreen).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Setting things up..." })
    );
    expect(screen.getByTestId("loading-screen")).toHaveTextContent(
      "Setting things up..."
    );
  });

  it("renders the playground instead of the loading screen once ready", () => {
    mockLoadingState.current = { kind: "ready" };

    render(<PlaygroundTab {...baseProps} />);

    expect(mockLoadingScreen).not.toHaveBeenCalled();
    expect(screen.getByTestId("playground-center")).toBeInTheDocument();
  });
});
