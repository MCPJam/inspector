import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { XAAFlowTab } from "../xaa/XAAFlowTab";
import type { XaaTestTarget } from "@/hooks/useXaaTestTarget";

const captureMock = vi.fn();
vi.mock("posthog-js", () => ({
  default: {
    capture: (...args: unknown[]) => captureMock(...args),
  },
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn().mockReturnValue("test"),
  detectPlatform: vi.fn().mockReturnValue("web"),
}));

vi.mock("../xaa/XAAIdpCard", () => ({
  XAAIdpCard: () => <div data-testid="xaa-idp-card" />,
}));

vi.mock("../xaa/XAAServerModal", () => ({
  XAAServerModal: () => <div data-testid="xaa-server-modal" />,
}));

vi.mock("../xaa/XAASimulatedIdentity", () => ({
  XAASimulatedIdentity: () => <div data-testid="xaa-simulated-identity" />,
}));

let resourceApps: unknown[] = [];
vi.mock("@/hooks/useXaaResourceApps", () => ({
  useXaaResourceApps: () => ({
    resourceApps,
    isLoading: false,
    isAuthenticated: true,
    error: null,
    upsert: vi.fn(),
    remove: vi.fn(),
  }),
}));

// Controllable resolved target. Each test sets it before render.
let currentTarget: XaaTestTarget;
vi.mock("@/hooks/useXaaTestTarget", () => ({
  useXaaTestTarget: () => currentTarget,
}));

vi.mock("../ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div />,
}));

vi.mock("../xaa/XAASequenceDiagram", () => ({
  XAASequenceDiagram: () => <div data-testid="xaa-sequence-diagram" />,
}));

vi.mock("../xaa/XAAFlowLogger", () => ({
  XAAFlowLogger: ({
    summary,
    actions,
  }: {
    summary: { serverUrl?: string };
    actions: { continueLabel: string };
  }) => (
    <div data-testid="xaa-flow-logger">
      <span data-testid="logger-server-url">
        {summary.serverUrl || "No target configured"}
      </span>
      <span data-testid="logger-continue-label">{actions.continueLabel}</span>
    </div>
  ),
}));

vi.mock("../xaa/registration/XAAResourceAppsSection", () => ({
  XAAResourceAppsSection: () => <div data-testid="xaa-resource-apps-section" />,
}));

vi.mock("../xaa/NegativeTestScorecard", () => ({
  NegativeTestScorecard: ({ unlocked }: { unlocked: boolean }) => (
    <div data-testid="xaa-scorecard" data-unlocked={String(unlocked)} />
  ),
}));

const runAllMock = vi.fn();
let capturedMachineConfig: any = null;
vi.mock("@/lib/xaa/debug-state-machine-adapter", () => ({
  createInspectorXAAStateMachine: (config: any) => {
    capturedMachineConfig = config;
    return {
      proceedToNextStep: vi.fn(),
      // A "successful" run marks the flow complete, which fires the success
      // telemetry + unlocks this target's scorecard.
      runAll: vi.fn(async () => {
        runAllMock();
        config.updateState({ currentStep: "complete", isBusy: false });
      }),
    };
  },
}));

function makeTarget(overrides: Partial<XaaTestTarget> = {}): XaaTestTarget {
  return {
    targetSource: "bar_server",
    targetKey: "bar_server:staging",
    isTestable: true,
    usesServerSideSecret: false,
    runInput: {
      mode: "local-profile",
      serverUrl: "https://staging.mcp.example.com",
      authzServerIssuer: "",
      clientId: "staging-client",
      clientSecret: "",
      scope: "",
      userId: "u",
      email: "e@example.com",
      negativeTestMode: "valid",
    },
    ...overrides,
  };
}

describe("XAAFlowTab", () => {
  beforeEach(() => {
    captureMock.mockClear();
    runAllMock.mockClear();
    capturedMachineConfig = null;
    resourceApps = [];
    localStorage.clear();
    currentTarget = makeTarget();
  });

  it("shows the not-testable state for a selected STDIO/non-OAuth server", () => {
    currentTarget = makeTarget({
      isTestable: false,
      notTestableReason:
        "This server can't be XAA-tested — it needs an HTTP URL and OAuth.",
    });

    render(
      <XAAFlowTab serverConfigs={{}} selectedServerName="local-stdio" />,
    );

    expect(
      screen.getByText(/can't be XAA-tested/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /run all/i }),
    ).toBeDisabled();
  });

  it("fires xaa_tab_viewed once per mount with a target_count", () => {
    resourceApps = [{ id: "a" }];
    render(
      <XAAFlowTab
        serverConfigs={{ s1: {} as any, s2: {} as any }}
        selectedServerName="none"
      />,
    );

    const viewed = captureMock.mock.calls.filter(
      ([event]) => event === "xaa_tab_viewed",
    );
    expect(viewed).toHaveLength(1);
    // 1 registration + 2 servers.
    expect(viewed[0][1]).toMatchObject({ target_count: 3 });
  });

  it("Run all drives the machine and fires telemetry carrying target_source", async () => {
    const user = userEvent.setup();
    render(
      <XAAFlowTab serverConfigs={{}} selectedServerName="staging" />,
    );

    await user.click(screen.getByRole("button", { name: /run all/i }));

    await waitFor(() => expect(runAllMock).toHaveBeenCalledTimes(1));
    expect(captureMock).toHaveBeenCalledWith(
      "xaa_flow_started",
      expect.objectContaining({
        mode: "local-profile",
        target_source: "bar_server",
      }),
    );
  });

  it("retargets the run summary when the selected server changes", () => {
    const { rerender } = render(
      <XAAFlowTab serverConfigs={{}} selectedServerName="staging" />,
    );
    expect(screen.getByTestId("logger-server-url")).toHaveTextContent(
      "https://staging.mcp.example.com",
    );

    currentTarget = makeTarget({
      targetKey: "bar_server:prod",
      runInput: {
        ...makeTarget().runInput,
        serverUrl: "https://prod.mcp.example.com",
      },
    });
    rerender(<XAAFlowTab serverConfigs={{}} selectedServerName="prod" />);

    expect(screen.getByTestId("logger-server-url")).toHaveTextContent(
      "https://prod.mcp.example.com",
    );
  });

  it("unlocks the scorecard per target — a green run on one leaves another locked", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <XAAFlowTab serverConfigs={{}} selectedServerName="staging" />,
    );

    // A successful run unlocks staging's scorecard.
    await user.click(screen.getByRole("button", { name: /run all/i }));
    await waitFor(() =>
      expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
        "data-unlocked",
        "true",
      ),
    );

    // Switching to a different server shows a locked scorecard — the green run
    // on staging must not unlock prod.
    currentTarget = makeTarget({
      targetKey: "bar_server:prod",
      runInput: {
        ...makeTarget().runInput,
        serverUrl: "https://prod.mcp.example.com",
      },
    });
    rerender(<XAAFlowTab serverConfigs={{}} selectedServerName="prod" />);

    expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
      "data-unlocked",
      "false",
    );
  });

  it("passes serverId/projectId to the machine for a confidential server", () => {
    currentTarget = makeTarget({
      usesServerSideSecret: true,
      serverId: "srv_1",
      projectId: "proj_1",
    });
    render(<XAAFlowTab serverConfigs={{}} selectedServerName="staging" />);

    expect(capturedMachineConfig).toMatchObject({
      serverId: "srv_1",
      projectId: "proj_1",
    });
    // The confidential secret is never handed to the machine from the browser.
    expect(capturedMachineConfig.clientSecret).toBe("");
  });

  it("no legacy 'Configure Target' / 'Configure XAA Debugger' copy remains", () => {
    render(<XAAFlowTab serverConfigs={{}} selectedServerName="staging" />);
    expect(screen.queryByText("Configure Target")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Configure XAA Debugger/i),
    ).not.toBeInTheDocument();
  });
});
