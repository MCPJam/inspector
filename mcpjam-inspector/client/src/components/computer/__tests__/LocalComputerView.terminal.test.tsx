import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The local face's TERMINAL branch. What matters here is the wiring, not
 * xterm: the pane must dial the LOCAL route, mint a fresh nonce carrying the
 * consent capability, and have upload switched off (the pane's drag-and-drop
 * posts to the CLOUD upload route).
 */

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (sel: (s: { themeMode: string }) => unknown) =>
    sel({ themeMode: "dark" }),
}));

vi.mock("@/lib/webmcp/use-surface-agent-bridge", () => ({
  useSurfaceAgentBridge: () => {},
}));

const mintSpy = vi.hoisted(() => vi.fn(async () => "nonce-xyz"));
vi.mock("@/lib/local-computer-consent", () => ({
  mintLocalTerminalNonce: mintSpy,
}));

const trackSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track: trackSpy }));

// Capture the props the pane receives instead of booting xterm under jsdom.
const terminalProps = vi.hoisted(
  () => [] as Array<Record<string, unknown>>,
);
vi.mock("../ComputerTerminal", () => ({
  ComputerTerminal: (props: Record<string, unknown>) => {
    terminalProps.push(props);
    return <div data-testid="local-terminal-pane" />;
  },
}));

import { LocalComputerView } from "../LocalComputerView";
import { LOCAL_TERMINAL_WS_PATH } from "@/lib/computer-terminal-connection";
import type { ComputerEngineState } from "@/hooks/useComputerEngine";

function engineState(
  overrides: Partial<ComputerEngineState> & {
    consent?: Partial<ComputerEngineState["consent"]>;
  } = {},
): ComputerEngineState {
  const { consent: consentOverrides, ...rest } = overrides;
  return {
    engine: "local",
    selectedEngine: "local",
    setEngine: vi.fn(),
    resolved: true,
    localAvailable: true,
    localTerminalAvailable: true,
    workspaceDisplayRoot: "~/.mcpjam/computer",
    cloudAvailable: true,
    toggleVisible: true,
    consent: {
      status: "granted",
      granted: true,
      token: "consent-token",
      grant: vi.fn().mockResolvedValue(true),
      revoke: vi.fn(),
      ...consentOverrides,
    },
    ...rest,
  };
}

beforeEach(() => {
  terminalProps.length = 0;
  mintSpy.mockClear();
  trackSpy.mockClear();
});

describe("LocalComputerView — terminal branch", () => {
  it("mounts the pane on the LOCAL route with upload disabled", () => {
    render(<LocalComputerView projectId="proj_1" engine={engineState()} />);

    expect(screen.getByTestId("local-terminal-pane")).toBeInTheDocument();
    const props = terminalProps[0]!;
    expect(props.wsPath).toBe(LOCAL_TERMINAL_WS_PATH);
    // Not merely "not true" — the pane must be told explicitly, because its
    // default is the cloud behavior.
    expect(props.uploadEnabled).toBe(false);
    expect(props.themeMode).toBe("dark");
  });

  it("mints a project-scoped nonce carrying the consent capability", async () => {
    render(<LocalComputerView projectId="proj_1" engine={engineState()} />);

    const mintToken = terminalProps[0]!.mintToken as () => Promise<string>;
    await expect(mintToken()).resolves.toBe("nonce-xyz");
    expect(mintSpy).toHaveBeenCalledWith({
      projectId: "proj_1",
      consentToken: "consent-token",
    });
  });

  it("emits computer_terminal_opened once for the local pane", async () => {
    render(<LocalComputerView projectId="proj_1" engine={engineState()} />);

    await waitFor(() =>
      expect(trackSpy).toHaveBeenCalledWith("computer_terminal_opened", {
        location: "computer_tab_local",
      }),
    );
    expect(
      trackSpy.mock.calls.filter((c) => c[0] === "computer_terminal_opened"),
    ).toHaveLength(1);
  });

  it("degrades to a note (and reports it) when node-pty isn't available", async () => {
    render(
      <LocalComputerView
        projectId="proj_1"
        engine={engineState({ localTerminalAvailable: false })}
      />,
    );

    expect(screen.queryByTestId("local-terminal-pane")).not.toBeInTheDocument();
    expect(screen.getByText(/isn't available/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(trackSpy).toHaveBeenCalledWith("local_terminal_unavailable", {
        reason: "terminal_unavailable",
      }),
    );
  });

  it("remounts the pane when the project changes", () => {
    const { rerender } = render(
      <LocalComputerView projectId="proj_1" engine={engineState()} />,
    );
    expect(terminalProps).toHaveLength(1);

    rerender(
      <LocalComputerView projectId="proj_2" engine={engineState()} />,
    );

    // `ComputerTerminal` connects from a mount-only effect, so without a
    // project key the live PTY would stay in the previous project's workspace
    // while this view showed the new one.
    expect(terminalProps.length).toBeGreaterThan(1);
    const latestMint = terminalProps.at(-1)!.mintToken as () => Promise<string>;
    void latestMint();
    expect(mintSpy).toHaveBeenLastCalledWith({
      projectId: "proj_2",
      consentToken: "consent-token",
    });
  });

  it("never mounts the pane before consent, whatever the probe says", () => {
    render(
      <LocalComputerView
        projectId="proj_1"
        engine={engineState({
          consent: { granted: false, token: null, status: "absent" },
        })}
      />,
    );

    expect(screen.queryByTestId("local-terminal-pane")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("local-computer-consent-gate"),
    ).toBeInTheDocument();
    expect(trackSpy).not.toHaveBeenCalledWith(
      "computer_terminal_opened",
      expect.anything(),
    );
  });
});
