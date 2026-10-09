vi.mock("@/components/browser/LocalBrowserOnboarding", () => ({
  LocalBrowserOnboarding: () => null,
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { id: "member" } }),
}));
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import { useBrowserWorkspaceStore } from "@/stores/browser-workspace-store";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  dismissRail,
  revealRail,
  type ExtensionStore,
} from "@/components/host-workspace/ExtensionWorkspaceProvider";

// PlaygroundTab pulls in a large hook + provider graph. We only care about the
// `loadingState` branch that decides whether the branded first-run loading
// screen shows, so neutralize everything else and drive `loadingState`.

vi.mock("@/hooks/useComputersEnabled", () => ({
  useBrowserWorkspaceEnabledState: () => true,
  useBrowserEnabledState: () => true,
}));
const mockLoadingScreen = vi.hoisted(() => vi.fn());
const mockPlaygroundCenter = vi.hoisted(() => vi.fn());
const mockCenterStore = vi.hoisted(() => ({
  current: null as ExtensionStore | null,
}));
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
  useQuery: () => undefined,
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ themeMode: "light", hostStyle: "claude" }),
}));
vi.mock("@/hooks/useClients", () => ({ useHost: () => ({ host: null }) }));
vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => [null, vi.fn()],
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({ servers: [] }),
}));
// The engine hook subscribes to environment and chat-session stores that
// re-render the tab once they settle; the loading branch under test renders
// before any of that matters.
vi.mock("@/hooks/useBrowserEngine", () => ({
  useBrowserEngine: () => ({
    engine: "cloud",
    selectedEngine: "cloud",
    setEngine: () => {},
    resolved: true,
    localAvailable: false,
    cloudAvailable: false,
    toggleVisible: false,
    environmentMode: false,
    consent: null,
  }),
}));
const mockUseAutoConnectProjectServers = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useAutoConnectProjectServers", () => ({
  useAutoConnectProjectServers: mockUseAutoConnectProjectServers,
}));
vi.mock("@/lib/host-compat/use-host-catalog", () => ({
  useHostCatalog: () => ({ catalog: null }),
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children?: ReactNode }) => children,
  ResizablePanel: ({ children }: { children?: ReactNode }) => children,
  ResizableHandle: () => null,
}));
vi.mock("@/components/ui/collapsed-panel-strip", () => ({
  CollapsedPanelStrip: ({ side }: { side: string }) => (
    <div data-testid={`collapsed-${side}-rail`} />
  ),
}));
// The rail's own tab strip: each tab's close, and Collapse panel.
vi.mock("@/components/playground/PlaygroundRightRail", async () => {
  const { useExtensionRail } = await import(
    "@/components/host-workspace/use-extension-rail"
  );
  return {
    PlaygroundRightRail: ({ onClose }: { onClose: () => void }) => {
      const rail = useExtensionRail();
      return (
        <div>
          {rail.tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-label={`Close ${tab.title}`}
              onClick={() => rail.close(tab.id)}
            />
          ))}
          <button type="button" aria-label="Collapse panel" onClick={onClose} />
        </div>
      );
    },
  };
});
// Relative to PlaygroundTab.tsx, so "../X" from this __tests__ dir resolves to
// the same module the source imports as "./X".
vi.mock("../PlaygroundCenter", async () => {
  const style = await import("@/contexts/scenario-client-style-context");
  const caps = await import(
    "@/contexts/scenario-client-capabilities-override-context"
  );
  const profile = await import("@/contexts/active-mcp-profile-context");
  const resolver = await import(
    "@/contexts/active-host-client-capabilities-context"
  );
  const extensions = await import(
    "@/components/host-workspace/ExtensionWorkspaceProvider"
  );
  return {
    PlaygroundCenter: (props: unknown) => {
      mockPlaygroundCenter(props);
      mockCenterStore.current = extensions.useExtensionStore();
      return (
        <>
          <div data-testid="playground-center">
            {JSON.stringify({
              style: style.useScenarioHostStyle(),
              theme: style.useScenarioHostTheme(),
              chatUi: style.useScenarioChatUiOverride(),
              capabilities: caps.useScenarioHostCapabilitiesOverride(),
              profile: profile.useActiveMcpProfile(),
              clientCapabilities: resolver.useActiveHostCapsResolver()(),
            })}
          </div>
          <textarea data-chat-composer-input="" aria-label="Composer" />
        </>
      );
    },
  };
});
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
    useActiveChatSessionStore.setState({
      sessionId: null,
      restoredSession: null,
      restorationPending: false,
    });
    useBrowserWorkspaceStore.setState({ conversations: {} });
    mockLoadingScreen.mockClear();
    mockPlaygroundCenter.mockClear();
    mockLoadingState.current = { kind: "skeleton" };
    mockUseAutoConnectProjectServers.mockClear();
  });

  it("suspends route-level auto-connect while onboarding is open", () => {
    render(<PlaygroundTab {...baseProps} suspendAutoConnect />);

    expect(mockUseAutoConnectProjectServers).toHaveBeenCalledWith(
      expect.objectContaining({ suspendAutoConnect: true }),
    );
  });

  it("does not close a persisted panel while conversation metadata is restoring", () => {
    useActiveChatSessionStore.setState({
      sessionId: "wire",
      restorationPending: true,
    });
    useBrowserWorkspaceStore.getState().openBrowser("wire");
    render(<PlaygroundTab {...baseProps} />);
    expect(useBrowserWorkspaceStore.getState().conversations.wire.open).toBe(
      true,
    );
    act(() =>
      useActiveChatSessionStore.getState().setRestorationPending(false),
    );
    expect(useBrowserWorkspaceStore.getState().conversations.wire.open).toBe(
      false,
    );
  });
  it("shows the branded 'Setting things up...' screen during the first-run skeleton", () => {
    mockLoadingState.current = { kind: "skeleton" };

    render(<PlaygroundTab {...baseProps} />);

    expect(mockLoadingScreen).toHaveBeenCalledTimes(1);
    expect(mockLoadingScreen).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Setting things up..." }),
    );
    expect(screen.getByTestId("loading-screen")).toHaveTextContent(
      "Setting things up...",
    );
  });

  it("renders the playground instead of the loading screen once ready", () => {
    mockLoadingState.current = { kind: "ready" };

    render(<PlaygroundTab {...baseProps} />);

    expect(mockLoadingScreen).not.toHaveBeenCalled();
    expect(screen.getByTestId("playground-center")).toBeInTheDocument();
  });

  it("reports readiness again when an already-ready Playground starts its first-run handoff", () => {
    mockLoadingState.current = { kind: "ready" };
    const beforeHandoff = vi.fn();
    const duringHandoff = vi.fn();
    const view = render(<PlaygroundTab {...baseProps} onReady={beforeHandoff} />);
    expect(beforeHandoff).toHaveBeenCalledOnce();

    view.rerender(<PlaygroundTab {...baseProps} onReady={duringHandoff} />);
    expect(duringHandoff).toHaveBeenCalledOnce();
  });

  it("passes the one-shot first-run prompt into the Playground center", () => {
    mockLoadingState.current = { kind: "ready" };
    const onFirstRunPromptConsumed = vi.fn();

    render(
      <PlaygroundTab
        {...baseProps}
        firstRunPrompt="What can this server do?"
        onFirstRunPromptConsumed={onFirstRunPromptConsumed}
      />,
    );

    expect(mockPlaygroundCenter).toHaveBeenCalledWith(
      expect.objectContaining({
        firstRunPrompt: "What can this server do?",
        onFirstRunPromptConsumed,
      }),
    );
  });
});

it("keeps the project host's style, overrides, profile, and saved capabilities", () => {
  mockLoadingState.current = { kind: "ready" };
  const host = {
    hostStyle: "codex",
    chatUiOverride: { label: "Custom" },
    hostCapabilitiesOverride: { tools: {} },
    mcpProfile: { version: 1 },
    clientCapabilities: { extensions: { "test/saved": {} } },
  } as any;
  render(<PlaygroundTab {...baseProps} activeHost={host} />);
  expect(
    JSON.parse(screen.getByTestId("playground-center").textContent!),
  ).toMatchObject({
    style: "codex",
    theme: "light",
    chatUi: host.chatUiOverride,
    capabilities: host.hostCapabilitiesOverride,
    profile: host.mcpProfile,
    clientCapabilities: host.clientCapabilities,
  });
});

describe("PlaygroundTab — leaving a model App's fullscreen in the side panel", () => {
  beforeEach(() => {
    useActiveChatSessionStore.setState({
      sessionId: null,
      restoredSession: null,
      restorationPending: false,
    });
    useBrowserWorkspaceStore.setState({ conversations: {} });
    mockLoadingState.current = { kind: "ready" };
    mockCenterStore.current = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The Playground's width (the chat/side-panel group is measured). */
  function renderAt(width: number) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width,
      height: 800,
      top: 0,
      left: 0,
      right: width,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    render(<PlaygroundTab {...baseProps} />);
  }
  /**
   * A model App goes fullscreen: it becomes the rail's selected tab and the
   * rail opens. Its exit returns it inline, which ends the tab.
   */
  function enterFullscreen() {
    const store = mockCenterStore.current!;
    const exit = vi.fn(() => store.setState({ modelFullscreen: null }));
    act(() => {
      store.setState({
        enabled: true,
        modelFullscreen: { label: "Bits & Bolts", exit },
      });
      revealRail(store);
    });
    return { store, exit };
  }
  const overlay = () => document.querySelector("[data-right-rail-overlay]");
  const railCollapsed = () => screen.queryByTestId("collapsed-right-rail");
  const composer = () => screen.getByRole("textbox", { name: "Composer" });

  it("narrow: the rail covers the chat while fullscreen; Exit full screen gives the chat and composer back", () => {
    renderAt(531);
    const { store } = enterFullscreen();
    expect(overlay()).not.toBeNull();
    expect(railCollapsed()).toBeNull();

    // The App's own Exit: it returns inline and dismisses the rail.
    act(() => {
      store.setState({ modelFullscreen: null });
      dismissRail(store);
    });
    expect(overlay()).toBeNull();
    expect(railCollapsed()).not.toBeNull();
    expect(composer()).toHaveFocus();
  });

  it("wide: the chat stays beside the rail, and Exit full screen leaves the rail open", () => {
    renderAt(1280);
    const { store } = enterFullscreen();
    expect(overlay()).toBeNull();
    expect(railCollapsed()).toBeNull();
    act(() => {
      store.setState({ modelFullscreen: null });
      dismissRail(store);
    });
    expect(overlay()).toBeNull();
    expect(railCollapsed()).toBeNull();
    expect(composer()).not.toHaveFocus();
  });

  it.each([
    ["narrow", 531],
    ["wide", 1280],
  ])(
    "%s: closing the fullscreen tab returns the App inline and never leaves an empty panel over the chat",
    (name, width) => {
      renderAt(width);
      const { exit } = enterFullscreen();
      fireEvent.click(
        screen.getByRole("button", { name: "Close Bits & Bolts" }),
      );
      expect(exit).toHaveBeenCalled();
      expect(
        screen.queryByRole("button", { name: "Close Bits & Bolts" }),
      ).toBeNull();
      expect(overlay()).toBeNull();
      // Only a narrow window gives up the rail to show the chat.
      expect(railCollapsed() !== null).toBe(name === "narrow");
      if (name === "narrow") expect(composer()).toHaveFocus();
    },
  );

  it.each([
    ["narrow", 531],
    ["wide", 1280],
  ])(
    "%s: collapsing the panel ends the fullscreen instead of leaving the App over the window",
    (_name, width) => {
      renderAt(width);
      const { exit } = enterFullscreen();
      fireEvent.click(screen.getByRole("button", { name: "Collapse panel" }));
      expect(exit).toHaveBeenCalledTimes(1);
      expect(overlay()).toBeNull();
      expect(railCollapsed()).not.toBeNull();
      expect(
        screen.queryByRole("button", { name: "Close Bits & Bolts" }),
      ).toBeNull();
    },
  );

  it("narrow: Escape dismisses the covering rail and returns focus to the composer", () => {
    renderAt(531);
    const { exit } = enterFullscreen();
    screen.getByRole("button", { name: "Collapse panel" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(overlay()).toBeNull();
    expect(railCollapsed()).not.toBeNull();
    expect(composer()).toHaveFocus();
  });
});
