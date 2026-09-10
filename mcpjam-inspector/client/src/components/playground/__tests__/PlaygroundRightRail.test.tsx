import { PlaygroundBrowserOverrideContext } from "../playground-browser-override";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

/**
 * The rail's Shell tab is engine-aware: the CLOUD controller
 * (`useComputerTerminal`, which reserves/wakes a real cloud box on open) must
 * never be mounted while the project's computer engine is local. These suites
 * pin exactly that — plus the indicator chip and the local body's three states
 * (unconsented / open-terminal prompt / terminal unavailable).
 */

const engineState = vi.hoisted(() => ({
  engine: "cloud" as "local" | "cloud",
  selectedEngine: "cloud" as "local" | "cloud",
  localTerminalAvailable: false,
  toggleVisible: true,
  granted: false,
}));

const terminalSpies = vi.hoisted(() => ({
  useComputerTerminal: vi.fn(),
  openTerminal: vi.fn(),
}));

vi.mock("@/hooks/useComputerEngine", () => ({
  useComputerEngine: () => ({
    engine: engineState.engine,
    selectedEngine: engineState.selectedEngine,
    setEngine: vi.fn(),
    resolved: true,
    localAvailable: true,
    localTerminalAvailable: engineState.localTerminalAvailable,
    workspaceDisplayRoot: "~/.mcpjam/computer",
    cloudAvailable: true,
    toggleVisible: engineState.toggleVisible,
    consent: {
      status: engineState.granted ? "granted" : "absent",
      granted: engineState.granted,
      token: engineState.granted ? "tok" : null,
      grant: vi.fn(),
      revoke: vi.fn(),
    },
  }),
}));

vi.mock("@/components/computer/useComputerTerminal", () => ({
  useComputerTerminal: (...args: unknown[]) => {
    terminalSpies.useComputerTerminal(...args);
    return {
      liveStatus: "ready",
      status: null,
      terminalOpen: false,
      starting: false,
      dataPlaneResolved: true,
      dataPlaneUnavailable: false,
      openTerminal: terminalSpies.openTerminal,
    };
  },
}));

vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabledState: () => true,
  useBrowserEnabledState: () => true,
  // ON, so the rail is the two-tab one the tests below describe. The Browser
  // tab is the FALLBACK for a workspace that is gated off, and it has its own
  // suite at the bottom of this file.
  useBrowserWorkspaceEnabled: () => workspaceFlag.enabled,
}));

/** Flipped by the fallback suite; on for everything else. */
const workspaceFlag = vi.hoisted(() => ({ enabled: true }));

vi.mock("@/components/logger-view", () => ({
  LoggerView: () => <div data-testid="logger-view" />,
}));

vi.mock("@/components/computer/ComputerStatusChip", () => ({
  ComputerStatusChip: () => <div data-testid="computer-status-chip" />,
}));

vi.mock("@/components/computer/ComputerTerminalPane", () => ({
  ComputerTerminalPane: () => <div data-testid="cloud-terminal-pane" />,
}));

// The bare terminal the LOCAL body mounts (xterm won't run under jsdom).
vi.mock("@/components/computer/ComputerTerminal", () => ({
  ComputerTerminal: () => <div data-testid="local-terminal" />,
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (s: { themeMode: string }) => unknown) =>
    selector({ themeMode: "light" }),
}));

vi.mock("@/lib/local-computer-consent", () => ({
  mintLocalTerminalNonce: vi.fn(),
}));

vi.mock("@/stores/harness-workdir-store", () => ({
  useHarnessWorkdir: () => undefined,
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

// Both panes are exercised in their own suites; here they only have to say
// which one the rail mounted and whether it considers it the visible tab.
vi.mock("@/components/browser/LocalBrowserBody", () => ({
  LocalBrowserBody: ({ active }: { active?: boolean }) => (
    <div
      data-testid="browser-pane"
      data-engine="local"
      data-active={String(active)}
    />
  ),
}));

vi.mock("@/components/browser/HostedBrowserBody", () => ({
  HostedBrowserBody: ({ active }: { active?: boolean }) => (
    <div
      data-testid="browser-pane"
      data-engine="hosted"
      data-active={String(active)}
    />
  ),
}));

vi.mock("@/stores/active-chat-session-store", () => ({
  useActiveChatSessionStore: (
    select: (state: { sessionId: string }) => unknown,
  ) => select({ sessionId: "chat-1" }),
}));

vi.mock("@/hooks/useProjectComputer", () => ({
  useMintBrowserToken: () => async () => ({
    token: "tok",
    expiresAt: Date.now() + 60_000,
  }),
  useMintConversationBrowserToken: () => async () => ({
    token: "tok",
    expiresAt: Date.now() + 60_000,
  }),
}));

import { PlaygroundRightRail } from "../PlaygroundRightRail";
import { useBrowserWorkspaceStore } from "@/stores/browser-workspace-store";

const hostConfig = { computer: { workdir: "/home/user" } } as any;

function renderRail() {
  return render(
    <PlaygroundRightRail
      onClose={() => {}}
      hostConfig={hostConfig}
      hostId="host-1"
      projectId="proj-1"
      isAuthenticated
    />,
  );
}

beforeEach(() => {
  engineState.engine = "cloud";
  engineState.selectedEngine = "cloud";
  engineState.localTerminalAvailable = false;
  engineState.toggleVisible = true;
  engineState.granted = false;
  terminalSpies.useComputerTerminal.mockClear();
  terminalSpies.openTerminal.mockClear();
  useBrowserWorkspaceStore.setState({
    conversations: {},
    revealSeq: 0,
    revealConversationId: null,
  });
});

describe("PlaygroundRightRail — engine indicator", () => {
  it("reads 'Cloud computer' on the cloud engine", () => {
    renderRail();
    expect(screen.getByTestId("rail-engine-chip")).toHaveTextContent(
      "Cloud computer",
    );
  });

  it("reads 'This machine' once local is both selected and consented", () => {
    engineState.engine = "local";
    engineState.selectedEngine = "local";
    engineState.granted = true;
    renderRail();
    expect(screen.getByTestId("rail-engine-chip")).toHaveTextContent(
      "This machine",
    );
  });

  it("still reads 'Cloud computer' when local is selected but unconsented — commands really do go to the cloud", () => {
    engineState.engine = "cloud"; // consent-gated resolution
    engineState.selectedEngine = "local";
    engineState.granted = false;
    renderRail();
    expect(screen.getByTestId("rail-engine-chip")).toHaveTextContent(
      "Cloud computer",
    );
  });

  it("is hidden when there is no engine choice to indicate (cloud body)", () => {
    engineState.toggleVisible = false;
    renderRail();
    expect(screen.queryByTestId("rail-engine-chip")).not.toBeInTheDocument();
  });

  it("is hidden on the LOCAL body too when there is no choice", () => {
    // Both bodies gate on the same flag — a local-only install (no cloud
    // computer) has nothing to indicate, and the body copy already names the
    // machine.
    engineState.engine = "local";
    engineState.selectedEngine = "local";
    engineState.granted = true;
    engineState.toggleVisible = false;
    renderRail();
    expect(screen.queryByTestId("rail-engine-chip")).not.toBeInTheDocument();
    // The body itself is still the local one.
    expect(
      screen.getByTestId("rail-local-terminal-unavailable"),
    ).toBeInTheDocument();
  });
});

describe("PlaygroundRightRail — cloud engine body", () => {
  it("mounts the cloud terminal controller and pane", () => {
    renderRail();
    expect(terminalSpies.useComputerTerminal).toHaveBeenCalled();
    expect(screen.getByTestId("cloud-terminal-pane")).toBeInTheDocument();
    expect(screen.getByTestId("computer-status-chip")).toBeInTheDocument();
  });

  it("offers Open terminal", () => {
    renderRail();
    expect(
      screen.getByRole("button", { name: /open terminal/i }),
    ).toBeInTheDocument();
  });
});

describe("PlaygroundRightRail — local engine body", () => {
  beforeEach(() => {
    engineState.selectedEngine = "local";
  });

  it("never mounts the cloud controller (no reserve behind the user's back)", () => {
    engineState.engine = "local";
    engineState.granted = true;
    renderRail();
    expect(terminalSpies.useComputerTerminal).not.toHaveBeenCalled();
    expect(terminalSpies.openTerminal).not.toHaveBeenCalled();
    expect(screen.queryByTestId("cloud-terminal-pane")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /open terminal/i }),
    ).not.toBeInTheDocument();
  });

  it("points at the Computer tab when this machine isn't authorized yet", () => {
    renderRail();
    expect(screen.getByTestId("rail-local-unconsented")).toBeInTheDocument();
    expect(terminalSpies.useComputerTerminal).not.toHaveBeenCalled();
    // The consent gate itself is the Computer tab's job — not duplicated here.
    expect(
      screen.queryByTestId("local-computer-consent-gate"),
    ).not.toBeInTheDocument();
  });

  it("offers Open terminal and mounts the LOCAL pane on click — never the cloud controller", () => {
    engineState.engine = "local";
    engineState.granted = true;
    engineState.localTerminalAvailable = true;
    renderRail();
    // Idle until asked: a PTY is a real shell on the user's machine, and both
    // rail bodies stay mounted, so nothing may spawn one on Playground load.
    expect(
      screen.getByTestId("rail-local-terminal-pointer"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("local-terminal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /open terminal/i }));
    expect(screen.getByTestId("local-terminal")).toBeInTheDocument();
    expect(screen.queryByTestId("cloud-terminal-pane")).not.toBeInTheDocument();
    expect(terminalSpies.useComputerTerminal).not.toHaveBeenCalled();
  });

  it("degrades honestly when the local terminal isn't available", () => {
    engineState.engine = "local";
    engineState.granted = true;
    engineState.localTerminalAvailable = false;
    renderRail();
    expect(
      screen.getByTestId("rail-local-terminal-unavailable"),
    ).toBeInTheDocument();
  });
});

describe("PlaygroundRightRail — flipping engines mid-session", () => {
  it("swaps the shell body (dropping the live cloud pane) and restores it on the way back", () => {
    const { rerender } = renderRail();
    expect(screen.getByTestId("cloud-terminal-pane")).toBeInTheDocument();

    engineState.engine = "local";
    engineState.selectedEngine = "local";
    engineState.granted = true;
    rerender(
      <PlaygroundRightRail
        onClose={() => {}}
        hostConfig={hostConfig}
        hostId="host-1"
        projectId="proj-1"
        isAuthenticated
      />,
    );
    expect(screen.queryByTestId("cloud-terminal-pane")).not.toBeInTheDocument();

    engineState.engine = "cloud";
    engineState.selectedEngine = "cloud";
    rerender(
      <PlaygroundRightRail
        onClose={() => {}}
        hostConfig={hostConfig}
        hostId="host-1"
        projectId="proj-1"
        isAuthenticated
      />,
    );
    expect(screen.getByTestId("cloud-terminal-pane")).toBeInTheDocument();
  });
});

describe("PlaygroundRightRail — no computer attached", () => {
  it("falls back to the plain log viewer", () => {
    render(
      <PlaygroundRightRail
        onClose={() => {}}
        hostConfig={{} as any}
        hostId="host-1"
        projectId="proj-1"
        isAuthenticated
      />,
    );
    expect(screen.getByTestId("logger-view")).toBeInTheDocument();
    expect(screen.queryByTestId("rail-engine-chip")).not.toBeInTheDocument();
  });

  it("falls back to the log viewer for a null hostConfig too", () => {
    render(
      <PlaygroundRightRail
        onClose={() => {}}
        hostConfig={null}
        hostId={null}
        projectId="proj-1"
        isAuthenticated
      />,
    );
    expect(screen.getByTestId("logger-view")).toBeInTheDocument();
    expect(terminalSpies.useComputerTerminal).not.toHaveBeenCalled();
  });
});

/**
 * The Browser tab's tests moved with the Browser tab.
 *
 * It is a panel beside chat now rather than the rail's third tab, and the
 * properties these used to pin — which body each engine gets, when the panel
 * is offered at all, and that a hidden pane stops claiming somebody is
 * watching — are pinned in `PlaygroundBrowserPanel.test.tsx` against their new
 * home. What is left here is the one thing that is about the RAIL: that the
 * old tab comes back when the workspace is gated off.
 */
describe("PlaygroundRightRail — the gated-off fallback", () => {
  const browserHost = {
    computer: { workdir: "/home/user" },
    builtInToolIds: ["browser"],
  } as any;

  afterEach(() => {
    workspaceFlag.enabled = true;
  });

  it("offers Browser from a temporary override without a host or Computer", () => {
    workspaceFlag.enabled = false;
    engineState.selectedEngine = "cloud";
    render(<PlaygroundBrowserOverrideContext.Provider value={true}>
      <PlaygroundRightRail onClose={() => {}} hostConfig={null} hostId={null} projectId="proj-1" isAuthenticated />
    </PlaygroundBrowserOverrideContext.Provider>);
    expect(screen.getByRole("button", { name: /browser/i })).toBeInTheDocument();
    expect(terminalSpies.useComputerTerminal).not.toHaveBeenCalled();
  });

  it.each(["local", "cloud"] as const)(
    "offers a %s Browser without Computer and never mounts a shell",
    (engine) => {
      workspaceFlag.enabled = false;
      engineState.selectedEngine = engine;
      // In particular, the local pane must be reachable BEFORE consent.
      engineState.granted = false;
      render(
        <PlaygroundRightRail
          onClose={() => {}}
          hostConfig={{ builtInToolIds: ["browser"] } as any}
          hostId="host-1"
          projectId="proj-1"
          isAuthenticated
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /browser/i }));
      expect(screen.getByTestId("browser-pane")).toHaveAttribute(
        "data-engine",
        engine === "local" ? "local" : "hosted",
      );
      expect(screen.getByTestId("browser-pane")).toHaveAttribute(
        "data-active",
        "true",
      );
      expect(
        screen.queryByRole("button", { name: /shell/i }),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("local-terminal")).not.toBeInTheDocument();
      expect(terminalSpies.useComputerTerminal).not.toHaveBeenCalled();
    },
  );

  function renderRail() {
    return render(
      <PlaygroundRightRail
        onClose={() => {}}
        hostConfig={browserHost}
        hostId="host-1"
        projectId="proj-1"
        isAuthenticated
      />,
    );
  }

  it("offers no Browser tab while the workspace panel is on", () => {
    // Two browsers on one screen is two panes claiming to be watched, on a
    // metered box, showing the same page.
    engineState.selectedEngine = "local";
    engineState.granted = true;
    renderRail();
    expect(
      screen.queryByRole("button", { name: /browser/i }),
    ).not.toBeInTheDocument();
  });

  it("brings the old tab back when the workspace is gated off", () => {
    // A flag that removed the panel and left nothing in its place would be
    // worse than either state it is choosing between.
    workspaceFlag.enabled = false;
    engineState.selectedEngine = "local";
    engineState.granted = true;
    renderRail();
    expect(
      screen.getByRole("button", { name: /browser/i }),
    ).toBeInTheDocument();
  });

  it("opens the Browser tab when the agent starts browsing", () => {
    workspaceFlag.enabled = false;
    engineState.selectedEngine = "local";
    engineState.granted = true;
    renderRail();
    expect(screen.getByTestId("browser-pane")).toHaveAttribute(
      "data-active",
      "false",
    );
    act(() => {
      useBrowserWorkspaceStore.getState().openBrowser("chat-1");
    });
    expect(screen.getByTestId("browser-pane")).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("stays on Logs once the person has left the browser", () => {
    workspaceFlag.enabled = false;
    engineState.selectedEngine = "local";
    engineState.granted = true;
    renderRail();
    act(() => {
      useBrowserWorkspaceStore.getState().openBrowser("chat-1");
    });
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    expect(screen.getByTestId("browser-pane")).toHaveAttribute(
      "data-active",
      "false",
    );
    act(() => {
      useBrowserWorkspaceStore.getState().openBrowser("chat-1");
    });
    expect(screen.getByTestId("browser-pane")).toHaveAttribute(
      "data-active",
      "false",
    );
  });
});

vi.mock("@/hooks/useBrowserEngine", () => ({
  useBrowserEngine: () => ({
    engine: engineState.engine,
    selectedEngine: engineState.selectedEngine,
    consent: {
      granted: engineState.granted,
      token: engineState.granted ? "browser-token" : null,
    },
  }),
}));
vi.mock("@/components/browser/BrowserRuntimeControls", () => ({
  BrowserRuntimeControls: () => null,
}));

vi.mock("@/components/browser/BrowserActivityList", () => ({
  BrowserActivityList: ({ active }: { active: boolean }) => (
    <div data-testid="browser-activity-logs" data-active={String(active)}>
      Browser activity
    </div>
  ),
}));

it("shows browser activity only in Logs and stops polling on the Browser tab", () => {
  workspaceFlag.enabled = false;
  engineState.selectedEngine = "local";
  engineState.granted = true;
  render(
    <PlaygroundRightRail
      onClose={() => {}}
      hostConfig={{ builtInToolIds: ["browser"] } as any}
      hostId="host-1"
      projectId="proj-1"
      isAuthenticated
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Logs" }));
  const activity = screen.getByTestId("browser-activity-logs");
  expect(activity).toBeVisible();
  expect(activity).toHaveAttribute("data-active", "true");
  fireEvent.click(screen.getByRole("button", { name: "Browser" }));
  expect(activity).not.toBeVisible();
  expect(activity).toHaveAttribute("data-active", "false");
});

it("does not mount browser history without browser consent", () => {
  workspaceFlag.enabled = false;
  engineState.selectedEngine = "local";
  engineState.granted = false;
  renderRail();
  expect(screen.queryByTestId("browser-activity-logs")).toBeNull();
});
