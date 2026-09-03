import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

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
}));

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

// The pane itself is exercised in its own suite; here it only has to say
// whether the rail considers it the visible tab.
vi.mock("@/components/browser/LocalBrowserBody", () => ({
  LocalBrowserBody: ({ active }: { active?: boolean }) => (
    <div data-testid="browser-pane" data-active={String(active)} />
  ),
}));

import { PlaygroundRightRail } from "../PlaygroundRightRail";

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

describe("PlaygroundRightRail — the Browser tab", () => {
  const browserHost = {
    computer: { workdir: "/home/user" },
    builtInToolIds: ["browser"],
  } as any;

  function renderWithBrowser() {
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

  it("tells the pane whether it is the tab being looked at", () => {
    // Mounted-hidden is not "being watched": the pane heartbeats to defer the
    // browser's idle reap, and one behind the Logs tab must stop claiming
    // somebody is looking at it.
    engineState.engine = "local";
    engineState.selectedEngine = "local";
    engineState.granted = true;
    renderWithBrowser();

    expect(screen.getByTestId("browser-pane").dataset.active).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /browser/i }));
    expect(screen.getByTestId("browser-pane").dataset.active).toBe("true");
  });

  it("falls back to Logs when the Browser tab disappears under it", () => {
    // Switching the engine to cloud hid the Browser body and left `activeTab`
    // on it, so all three panes were hidden and the rail looked broken.
    engineState.engine = "local";
    engineState.selectedEngine = "local";
    engineState.granted = true;
    const { rerender } = renderWithBrowser();
    fireEvent.click(screen.getByRole("button", { name: /browser/i }));
    expect(screen.getByTestId("browser-pane").dataset.active).toBe("true");

    engineState.engine = "cloud";
    engineState.selectedEngine = "cloud";
    rerender(
      <PlaygroundRightRail
        onClose={() => {}}
        hostConfig={browserHost}
        hostId="host-1"
        projectId="proj-1"
        isAuthenticated
      />,
    );

    expect(screen.queryByTestId("browser-pane")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-terminal-pane")).toBeInTheDocument();
  });
});
