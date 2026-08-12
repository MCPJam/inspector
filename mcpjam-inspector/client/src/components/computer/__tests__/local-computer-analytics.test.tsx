import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The local-engine analytics funnel. Two things are being pinned:
 *  1. each emit fires ONCE, at the right moment;
 *  2. every payload is CONTENT-FREE — enums, booleans and locations only.
 *     No command text, no workspace path, no project id, no consent token.
 */

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (sel: (s: { themeMode: string }) => unknown) =>
    sel({ themeMode: "dark" }),
}));

vi.mock("@/lib/webmcp/use-surface-agent-bridge", () => ({
  useSurfaceAgentBridge: () => {},
}));

vi.mock("@/lib/local-computer-consent", () => ({
  mintLocalTerminalNonce: vi.fn(async () => "nonce"),
}));

vi.mock("../ComputerTerminal", () => ({
  ComputerTerminal: () => <div data-testid="local-terminal-pane" />,
}));

const trackSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track: trackSpy }));

vi.mock("@/lib/config", () => ({ HOSTED_MODE: false }));

vi.mock("../ComputerView", () => ({
  ComputerView: () => <div data-testid="cloud-computer-view" />,
}));

const engineHookState = vi.hoisted(() => ({
  setEngine: vi.fn(),
}));
vi.mock("@/hooks/useComputerEngine", () => ({
  useComputerEngine: () => ({
    engine: "cloud",
    selectedEngine: "cloud",
    setEngine: engineHookState.setEngine,
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
      grant: vi.fn(),
      revoke: vi.fn(),
    },
  }),
}));

import { LocalComputerConsentGate } from "../LocalComputerConsentGate";
import { LocalComputerView } from "../LocalComputerView";
import { ComputerTabView } from "../ComputerTabView";
import type { ComputerEngineState } from "@/hooks/useComputerEngine";

/** Every prop value we ever emit, flattened, so it can be scanned for content. */
function allEmittedValues(): string[] {
  return trackSpy.mock.calls.flatMap(([, props]) =>
    Object.values((props ?? {}) as Record<string, unknown>).map(String),
  );
}

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
      revoke: vi.fn().mockResolvedValue(undefined),
      ...consentOverrides,
    },
    ...rest,
  };
}

beforeEach(() => {
  trackSpy.mockClear();
  engineHookState.setEngine.mockClear();
});

describe("consent gate analytics", () => {
  it("reports the gate exactly once on mount", () => {
    const { rerender } = render(
      <LocalComputerConsentGate onAllow={() => true} onUseCloud={() => {}} />,
    );
    rerender(
      <LocalComputerConsentGate onAllow={() => true} onUseCloud={() => {}} />,
    );

    const shown = trackSpy.mock.calls.filter(
      (c) => c[0] === "local_computer_consent_gate_shown",
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]![1]).toEqual({
      location: "computer_tab_local",
      cloud_offered: true,
    });
  });

  it("records whether a decline affordance even existed", () => {
    render(<LocalComputerConsentGate onAllow={() => true} />);
    expect(
      trackSpy.mock.calls.find(
        (c) => c[0] === "local_computer_consent_gate_shown",
      )![1],
    ).toEqual({ location: "computer_tab_local", cloud_offered: false });
  });

  it("reports a successful Allow", async () => {
    render(
      <LocalComputerConsentGate
        onAllow={async () => true}
        onUseCloud={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /allow/i }));

    await waitFor(() =>
      expect(trackSpy).toHaveBeenCalledWith("local_computer_consent_granted", {
        location: "computer_tab_local",
        outcome: "stored",
      }),
    );
  });

  it("reports a FAILED Allow as an outcome, not a silent drop", async () => {
    render(
      <LocalComputerConsentGate
        onAllow={async () => false}
        onUseCloud={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /allow/i }));

    await waitFor(() =>
      expect(trackSpy).toHaveBeenCalledWith("local_computer_consent_granted", {
        location: "computer_tab_local",
        outcome: "failed",
      }),
    );
  });

  it("reports a REJECTED Allow the same way", async () => {
    render(
      <LocalComputerConsentGate
        onAllow={async () => {
          throw new Error("boom");
        }}
        onUseCloud={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /allow/i }));

    await waitFor(() =>
      expect(trackSpy).toHaveBeenCalledWith("local_computer_consent_granted", {
        location: "computer_tab_local",
        outcome: "failed",
      }),
    );
  });

  it("reports the decline path and still switches to cloud", () => {
    const onUseCloud = vi.fn();
    render(
      <LocalComputerConsentGate onAllow={() => true} onUseCloud={onUseCloud} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /use cloud instead/i }));

    expect(trackSpy).toHaveBeenCalledWith("local_computer_consent_denied", {
      location: "computer_tab_local",
    });
    expect(onUseCloud).toHaveBeenCalledTimes(1);
  });
});

describe("re-authorize analytics", () => {
  it("reports the re-authorize action once and still revokes", async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    render(
      <LocalComputerView
        projectId="proj_secret_name"
        engine={engineState({
          consent: { granted: true, token: "tok", status: "granted", revoke },
        })}
      />,
    );
    fireEvent.click(screen.getByTestId("local-computer-reauthorize"));

    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    const calls = trackSpy.mock.calls.filter(
      (c) => c[0] === "local_computer_consent_reauthorized",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({ location: "computer_tab_local" });
  });
});

describe("engine toggle analytics", () => {
  it("reports the selected engine name and applies the preference", () => {
    render(<ComputerTabView projectId="proj_1" isSignedInMember />);

    fireEvent.click(screen.getByRole("button", { name: /This machine/i }));

    expect(trackSpy).toHaveBeenCalledWith("computer_engine_selected", {
      location: "computer_tab",
      engine: "local",
    });
    expect(engineHookState.setEngine).toHaveBeenCalledWith("local");
  });
});

describe("payload hygiene", () => {
  it("never emits a project id, workspace path, or consent token", async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    render(
      <LocalComputerView
        projectId="proj_secret_name"
        engine={engineState({
          consent: {
            granted: true,
            token: "super-secret-consent-token",
            status: "granted",
            revoke,
          },
        })}
      />,
    );
    fireEvent.click(screen.getByTestId("local-computer-reauthorize"));
    await waitFor(() => expect(revoke).toHaveBeenCalled());

    const values = allEmittedValues();
    expect(values.length).toBeGreaterThan(0);
    expect(values).not.toContain("proj_secret_name");
    expect(values).not.toContain("super-secret-consent-token");
    expect(values.join("|")).not.toContain("~/.mcpjam/computer");
  });
});
