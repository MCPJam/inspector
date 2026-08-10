import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The agent bridge is exercised in LocalComputerView.agent.test — here it's a
// no-op so these render tests don't touch the global command registry.
vi.mock("@/lib/webmcp/use-surface-agent-bridge", () => ({
  useSurfaceAgentBridge: () => {},
}));

import { LocalComputerView } from "../LocalComputerView";
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
    localTerminalAvailable: false,
    workspaceDisplayRoot: "~/.mcpjam/computer",
    cloudAvailable: true,
    toggleVisible: true,
    consent: {
      status: "absent",
      granted: false,
      token: null,
      grant: vi.fn().mockResolvedValue(true),
      revoke: vi.fn(),
      ...consentOverrides,
    },
    ...rest,
  };
}

describe("LocalComputerView", () => {
  it("renders the 'This machine' identity and the per-project workdir", () => {
    render(<LocalComputerView projectId="proj_1" engine={engineState()} />);
    expect(screen.getByTestId("this-machine-chip")).toBeInTheDocument();
    expect(
      screen.getByText("~/.mcpjam/computer/proj_1"),
    ).toBeInTheDocument();
  });

  it("shows the consent gate until consent is granted", () => {
    render(<LocalComputerView projectId="proj_1" engine={engineState()} />);
    expect(
      screen.getByTestId("local-computer-consent-gate"),
    ).toBeInTheDocument();
  });

  it("Allow grants consent then pins the engine preference to local", async () => {
    const grant = vi.fn().mockResolvedValue(true);
    const setEngine = vi.fn();
    render(
      <LocalComputerView
        projectId="proj_1"
        engine={engineState({ setEngine, consent: { grant } })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Allow$/ }));
    await waitFor(() => expect(grant).toHaveBeenCalledTimes(1));
    expect(setEngine).toHaveBeenCalledWith("local");
  });

  it("does not pin the engine if the grant fails", async () => {
    const grant = vi.fn().mockResolvedValue(false);
    const setEngine = vi.fn();
    render(
      <LocalComputerView
        projectId="proj_1"
        engine={engineState({ setEngine, consent: { grant } })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Allow$/ }));
    await waitFor(() =>
      expect(screen.getByTestId("consent-error")).toBeInTheDocument(),
    );
    expect(setEngine).not.toHaveBeenCalled();
  });

  it("offers 'Use cloud instead' only when a cloud computer exists", () => {
    const setEngine = vi.fn();
    const { rerender } = render(
      <LocalComputerView
        projectId="proj_1"
        engine={engineState({ cloudAvailable: true, setEngine })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Use cloud instead/i }));
    expect(setEngine).toHaveBeenCalledWith("cloud");

    rerender(
      <LocalComputerView
        projectId="proj_1"
        engine={engineState({ cloudAvailable: false })}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Use cloud instead/i }),
    ).not.toBeInTheDocument();
  });

  it("once granted, shows the terminal-not-available-yet note (terminal ships later)", () => {
    render(
      <LocalComputerView
        projectId="proj_1"
        engine={engineState({
          localTerminalAvailable: false,
          consent: { granted: true, token: "tok", status: "granted" },
        })}
      />,
    );
    expect(
      screen.queryByTestId("local-computer-consent-gate"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/terminal for this machine isn't available yet/i),
    ).toBeInTheDocument();
  });
});
