import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { XAAFlowTab } from "../xaa/XAAFlowTab";
import type { XaaTestTarget } from "@/hooks/useXaaTestTarget";
import { buildXaaDcrCredentialCacheKey } from "@/lib/xaa/types";

const captureMock = vi.fn();
vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => captureMock(...args),
}));

// Controllable signed-in state: null simulates a guest session.
let authUser: { email: string } | null = { email: "tester@example.com" };
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: authUser }),
}));

vi.mock("../xaa/XAAIdpCard", () => ({
  XAAIdpCard: () => <div data-testid="xaa-idp-card" />,
}));

let capturedServerModalProps: any = null;
vi.mock("../xaa/XAAServerModal", () => ({
  XAAServerModal: (props: any) => {
    capturedServerModalProps = props;
    return <div data-testid="xaa-server-modal" />;
  },
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

// Controllable global run settings (simulated identity + mode). Tests mutate
// runSettingsState then rerender to drive an identity edit.
let runSettingsState: {
  userId: string;
  email: string;
  negativeTestMode: "valid" | "expired" | "wrong_audience" | "bad_signature";
  issuerMode: "local" | "hosted";
} = {
  userId: "u",
  email: "e@example.com",
  negativeTestMode: "valid",
  issuerMode: "local",
};
const setIdentityMock = vi.fn();
const setNegativeTestModeMock = vi.fn();
vi.mock("@/hooks/useXaaRunSettings", () => ({
  useXaaRunSettings: () => ({
    ...runSettingsState,
    isDefaultIdentity: false,
    setIdentity: setIdentityMock,
    setNegativeTestMode: setNegativeTestModeMock,
  }),
}));

vi.mock("../ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    direction,
  }: {
    children?: ReactNode;
    direction?: "horizontal" | "vertical";
  }) => <div data-resizable-direction={direction}>{children}</div>,
  ResizablePanel: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: ({ "aria-label": ariaLabel }: { "aria-label"?: string }) => (
    <div role="separator" aria-label={ariaLabel} />
  ),
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
    actions: {
      continueLabel: string;
      continueDisabled?: boolean;
      runAllDisabled?: boolean;
      isRunningAll?: boolean;
      onContinue?: () => void;
      onRunAll?: () => void;
    };
  }) => (
    <div data-testid="xaa-flow-logger">
      <span data-testid="logger-server-url">
        {summary.serverUrl || "No target configured"}
      </span>
      <span data-testid="logger-continue-label">{actions.continueLabel}</span>
      <button
        type="button"
        data-testid="logger-run-all"
        disabled={actions.runAllDisabled || !actions.onRunAll}
        onClick={() => actions.onRunAll?.()}
      >
        Run all
      </button>
      <button
        type="button"
        data-testid="logger-continue"
        disabled={actions.continueDisabled || !actions.onContinue}
        onClick={() => actions.onContinue?.()}
      >
        {actions.continueLabel}
      </button>
    </div>
  ),
}));

vi.mock("../xaa/registration/XAAResourceAppsSection", () => ({
  XAAResourceAppsSection: ({
    onSelect,
  }: {
    onSelect: (app: { id: string }) => void;
  }) => (
    <button
      type="button"
      data-testid="select-registration"
      onClick={() => onSelect({ id: "app_1" })}
    >
      select registration
    </button>
  ),
}));

let capturedScorecardProps: any = null;
vi.mock("../xaa/NegativeTestScorecard", () => ({
  NegativeTestScorecard: (props: any) => {
    capturedScorecardProps = props;
    return (
      <div
        data-testid="xaa-scorecard"
        data-unlocked={String(props.unlocked)}
        data-has-input={String(props.input !== null)}
        data-audience={props.input?.audience ?? ""}
        data-client-id={props.input?.clientId ?? ""}
        data-auth-method={props.input?.tokenEndpointAuthMethod ?? ""}
        data-unavailable-reason={props.unavailableReason ?? ""}
      />
    );
  },
}));

const runAllMock = vi.fn();
let capturedMachineConfig: any = null;
let machineShouldComplete = true;
let machineCompletionUpdates: Record<string, unknown> = {};
vi.mock("@/lib/xaa/debug-state-machine-adapter", () => ({
  createInspectorXAAStateMachine: (config: any) => {
    capturedMachineConfig = config;
    return {
      proceedToNextStep: vi.fn(),
      // A "successful" run marks the flow complete (fires success telemetry +
      // unlocks the scorecard); an unsuccessful one leaves it mid-flow.
      runAll: vi.fn(async () => {
        runAllMock();
        if (machineShouldComplete) {
          config.updateState({
            ...machineCompletionUpdates,
            currentStep: "complete",
            isBusy: false,
          });
        }
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
    secretUnavailable: false,
    serversLoading: false,
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
    capturedServerModalProps = null;
    capturedScorecardProps = null;
    machineShouldComplete = true;
    machineCompletionUpdates = {};
    // Reset like every other module-level mutable: the issuer-kind test flips
    // authUser to null (guest), and a mid-test failure must not leak that into
    // later tests.
    authUser = { email: "tester@example.com" };
    resourceApps = [];
    localStorage.clear();
    runSettingsState = {
      userId: "u",
      email: "e@example.com",
      negativeTestMode: "valid",
      issuerMode: "local",
    };
    setIdentityMock.mockClear();
    setNegativeTestModeMock.mockClear();
    currentTarget = makeTarget();
  });

  it("places the negative-test scorecard behind a vertical resize handle", () => {
    render(<XAAFlowTab serverConfigs={{}} selectedServerName="staging" />);

    expect(
      screen.getByRole("separator", {
        name: /resize negative-test scorecard/i,
      })
    ).toBeInTheDocument();
    expect(
      screen
        .getByTestId("xaa-scorecard")
        .closest('[data-resizable-direction="vertical"]')
    ).not.toBeNull();
  });

  it("shows the not-testable state naming the server, with a configure CTA", () => {
    currentTarget = makeTarget({ isTestable: false });

    render(<XAAFlowTab serverConfigs={{}} selectedServerName="local-stdio" />);

    expect(screen.getByText(/Not XAA-compatible/i)).toBeInTheDocument();
    // The card names the selected server and points at the config modal.
    expect(screen.getByText("local-stdio")).toBeInTheDocument();
    expect(
      screen.getByText(/needs an HTTP URL and OAuth/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /configure server to test/i })
    ).toBeInTheDocument();
    // No run controls (and no top-bar Run all) in the not-testable state.
    expect(screen.queryByTestId("logger-run-all")).not.toBeInTheDocument();
  });

  it("'Back to start' clears the selection from the not-testable state", async () => {
    const user = userEvent.setup();
    const onSelectServer = vi.fn();
    currentTarget = makeTarget({ isTestable: false });

    render(
      <XAAFlowTab
        serverConfigs={{}}
        selectedServerName="local-stdio"
        onSelectServer={onSelectServer}
      />
    );

    await user.click(screen.getByRole("button", { name: /back to start/i }));
    expect(onSelectServer).toHaveBeenCalledWith("none");
  });

  it("fires xaa_tab_viewed once per mount with a target_count", () => {
    resourceApps = [{ id: "a" }];
    render(
      <XAAFlowTab
        serverConfigs={{ s1: {} as any, s2: {} as any }}
        selectedServerName="none"
      />
    );

    const viewed = captureMock.mock.calls.filter(
      ([event]) => event === "xaa_tab_viewed"
    );
    expect(viewed).toHaveLength(1);
    // 1 registration + 2 servers.
    expect(viewed[0][1]).toMatchObject({ target_count: 3 });
  });

  it("Run all drives the machine and fires telemetry carrying target_source", async () => {
    const user = userEvent.setup();
    render(<XAAFlowTab serverConfigs={{}} selectedServerName="staging" />);

    await user.click(screen.getByRole("button", { name: /run all/i }));

    await waitFor(() => expect(runAllMock).toHaveBeenCalledTimes(1));
    expect(captureMock).toHaveBeenCalledWith(
      "xaa_flow_started",
      expect.objectContaining({
        mode: "local-profile",
        target_source: "bar_server",
      })
    );
  });

  it("a debounced identity reset can't wipe a run started within its window", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <XAAFlowTab serverConfigs={{}} selectedServerName="staging" />
    );

    // Edit the simulated identity — arms the 400ms debounced flow rebuild.
    runSettingsState = { ...runSettingsState, userId: "john" };
    currentTarget = makeTarget({
      runInput: { ...makeTarget().runInput, userId: "john" },
    });
    rerender(<XAAFlowTab serverConfigs={{}} selectedServerName="staging" />);

    // Start a run inside that window — Run all rebuilds + drives to complete.
    await user.click(screen.getByRole("button", { name: /run all/i }));
    await waitFor(() => expect(runAllMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("logger-continue-label")).toHaveTextContent(
      "Flow Complete"
    );

    // Let the debounce elapse: the stale timer must skip (Run all already
    // applied this identity) rather than rebuild and wipe the completed run.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.getByTestId("logger-continue-label")).toHaveTextContent(
      "Flow Complete"
    );
  });

  it("retargets the run summary when the selected server changes", () => {
    const { rerender } = render(
      <XAAFlowTab serverConfigs={{}} selectedServerName="staging" />
    );
    expect(screen.getByTestId("logger-server-url")).toHaveTextContent(
      "https://staging.mcp.example.com"
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
      "https://prod.mcp.example.com"
    );
  });

  it("resets a completed flow when its server configuration changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <XAAFlowTab serverConfigs={{}} selectedServerName="staging" />
    );

    await user.click(screen.getByRole("button", { name: /run all/i }));
    await waitFor(() =>
      expect(screen.getByTestId("logger-continue-label")).toHaveTextContent(
        "Flow Complete"
      )
    );

    currentTarget = makeTarget({
      runInput: {
        ...makeTarget().runInput,
        scope: "new-scope",
        serverUrl: "https://new.mcp.example.com",
      },
    });
    rerender(<XAAFlowTab serverConfigs={{}} selectedServerName="staging" />);

    await user.click(screen.getByRole("button", { name: /reset flow/i }));
    expect(screen.getByTestId("logger-continue-label")).toHaveTextContent(
      "Start"
    );
    expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
      "data-unlocked",
      "false"
    );
  });

  it("unlocks the scorecard per target — a green run on one leaves another locked", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <XAAFlowTab serverConfigs={{}} selectedServerName="staging" />
    );

    // A successful run unlocks staging's scorecard.
    await user.click(screen.getByRole("button", { name: /run all/i }));
    await waitFor(() =>
      expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
        "data-unlocked",
        "true"
      )
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
      "false"
    );
  });

  it("uses the discovered issuer for a confidential server whose AS metadata discovery was skipped", async () => {
    const user = userEvent.setup();
    currentTarget = makeTarget({
      usesServerSideSecret: true,
      serverId: "srv_1",
      projectId: "proj_1",
    });
    machineCompletionUpdates = {
      authzServerIssuer: "https://as.example.com",
      resourceMetadata: {
        resource: "https://staging.mcp.example.com",
      },
    };

    render(
      <XAAFlowTab
        serverConfigs={{ staging: {} as any }}
        selectedServerName="staging"
        projectId="proj_1"
      />
    );

    await user.click(screen.getByRole("button", { name: /run all/i }));

    await waitFor(() =>
      expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
        "data-audience",
        "https://as.example.com"
      )
    );
    expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
      "data-has-input",
      "true"
    );
    expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
      "data-unavailable-reason",
      ""
    );
  });

  it("blocks Run (no empty-secret request) when a confidential secret can't be resolved", () => {
    currentTarget = makeTarget({
      usesServerSideSecret: true,
      secretUnavailable: true,
      serversLoading: false,
      serverId: undefined,
    });
    render(<XAAFlowTab serverConfigs={{}} selectedServerName="staging" />);

    expect(screen.getByRole("button", { name: /run all/i })).toBeDisabled();
    expect(
      screen.getByText(/couldn't resolve this server's saved secret/i)
    ).toBeInTheDocument();
  });

  it("shows a transient resolving message while project servers load", () => {
    currentTarget = makeTarget({
      usesServerSideSecret: true,
      secretUnavailable: true,
      serversLoading: true,
      serverId: undefined,
    });
    render(<XAAFlowTab serverConfigs={{}} selectedServerName="staging" />);
    expect(
      screen.getByText(/resolving this server's saved secret/i)
    ).toBeInTheDocument();
  });

  it("derives the org issuer kind for signed-in users and anonymous for guests", () => {
    currentTarget = makeTarget({});

    authUser = { email: "tester@example.com" };
    const { unmount } = render(
      <XAAFlowTab
        serverConfigs={{}}
        selectedServerName="staging"
        organizationId="org_1"
      />
    );
    expect(capturedMachineConfig).toMatchObject({ issuerKind: "org" });
    unmount();

    capturedMachineConfig = null;
    authUser = null; // guest session
    render(
      <XAAFlowTab
        serverConfigs={{}}
        selectedServerName="staging"
        organizationId="org_1"
      />
    );
    expect(capturedMachineConfig).toMatchObject({ issuerKind: "anonymous" });
    authUser = { email: "tester@example.com" };
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
      screen.queryByText(/Configure XAA Debugger/i)
    ).not.toBeInTheDocument();
  });

  it("surfaces the registration override with a clear control", async () => {
    const user = userEvent.setup();
    resourceApps = [
      {
        id: "app_1",
        name: "AcmeApp",
        resourceType: "mcp",
        resourceUrl: "https://acme.example.com/mcp",
        authServerMode: "own",
        issuer: "https://acme-as.example.com",
        scopes: [],
        hasSecret: true,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    currentTarget = makeTarget({
      targetSource: "registration",
      targetKey: "registration:app_1",
      runInput: { ...makeTarget().runInput, mode: "hosted-registration" },
    });

    render(<XAAFlowTab serverConfigs={{}} selectedServerName="none" />);
    await user.click(screen.getByTestId("select-registration"));

    expect(
      screen.getByText(/Using registered app — overrides the bar selection/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /use bar server/i })
    ).toBeInTheDocument();
  });

  it("keeps the selected bar server context for the configuration modal during a registration run", () => {
    currentTarget = makeTarget({
      targetSource: "registration",
      targetKey: "registration:app_1",
      serverId: undefined,
      projectId: undefined,
      barServerId: "srv_bar",
      barServerProjectId: "proj_bar",
      runInput: { ...makeTarget().runInput, mode: "hosted-registration" },
    });

    render(
      <XAAFlowTab
        serverConfigs={{ staging: {} as any }}
        selectedServerName="staging"
      />
    );

    expect(capturedServerModalProps).toMatchObject({
      projectId: "proj_bar",
      hostedServerId: "srv_bar",
    });
  });

  it("xaa_flow_started carries a salted target_id (no raw name/url)", async () => {
    const user = userEvent.setup();
    render(<XAAFlowTab serverConfigs={{}} selectedServerName="staging" />);
    await user.click(screen.getByRole("button", { name: /run all/i }));

    const started = captureMock.mock.calls.find(
      ([event]) => event === "xaa_flow_started"
    );
    expect(started?.[1].target_id).toMatch(/^[0-9a-f]{8}$/);
    expect(started?.[1].target_id).not.toContain("staging");
  });

  it("fires xaa_flow_completed with target_source at both the success and failure sites", async () => {
    const user = userEvent.setup();

    // Success site: the run reaches complete (effect-driven event).
    machineShouldComplete = true;
    const { unmount } = render(
      <XAAFlowTab serverConfigs={{}} selectedServerName="staging" />
    );
    await user.click(screen.getByRole("button", { name: /run all/i }));
    await waitFor(() =>
      expect(captureMock).toHaveBeenCalledWith(
        "xaa_flow_completed",
        expect.objectContaining({ success: true, target_source: "bar_server" })
      )
    );
    unmount();

    // Failure site: the run stops mid-flow (callback-driven event).
    captureMock.mockClear();
    machineShouldComplete = false;
    render(<XAAFlowTab serverConfigs={{}} selectedServerName="staging" />);
    await user.click(screen.getByRole("button", { name: /run all/i }));
    await waitFor(() =>
      expect(captureMock).toHaveBeenCalledWith(
        "xaa_flow_completed",
        expect.objectContaining({
          success: false,
          target_source: "bar_server",
        })
      )
    );
  });

  describe("registration strategy (persisted, modal-owned)", () => {
    // The on-flow selector band was removed: the strategy is chosen in the
    // Configure Server modal and persisted on the server config. The flow reads
    // it from serverConfigs[selectedServerName].registrationMode.
    const withStrategy = (strategy: string) =>
      ({ staging: { registrationMode: strategy } } as any);

    it("threads a persisted dcr strategy to the machine, with the session cache", () => {
      render(
        <XAAFlowTab
          serverConfigs={withStrategy("dcr")}
          selectedServerName="staging"
        />
      );

      // No on-flow selector band any more.
      expect(
        screen.queryByText(/client registration/i)
      ).not.toBeInTheDocument();
      expect(capturedMachineConfig.registrationStrategy).toBe("dcr");
      expect(capturedMachineConfig.dcrCredentialCache).toBeDefined();
      expect(capturedMachineConfig.dcrCacheTargetKey).toBe(
        currentTarget.targetKey
      );
    });

    it("unlocks DCR negative tests with the dynamically registered credentials", async () => {
      const user = userEvent.setup();
      render(
        <XAAFlowTab
          serverConfigs={withStrategy("dcr")}
          selectedServerName="staging"
        />
      );

      const registrationEndpoint = "https://auth.example.com/register";
      const cacheKey = buildXaaDcrCredentialCacheKey({
        targetKey: currentTarget.targetKey,
        registrationEndpoint,
      });
      capturedMachineConfig.dcrCredentialCache.set(cacheKey, {
        clientId: "dynamic-client",
        clientSecret: "session-only-secret",
        clientSecretExpiresAt: 0,
        tokenEndpointAuthMethod: "client_secret_basic",
        registrationEndpoint,
      });
      machineCompletionUpdates = {
        registrationStrategy: "dcr",
        clientId: "dynamic-client",
        tokenEndpoint: "https://auth.example.com/token",
        tokenEndpointAuthMethod: "client_secret_basic",
        authzMetadata: {
          issuer: "https://auth.example.com",
          registration_endpoint: registrationEndpoint,
        },
        resourceMetadata: { resource: "https://staging.mcp.example.com" },
      };

      await user.click(screen.getByRole("button", { name: /run all/i }));

      await waitFor(() =>
        expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
          "data-unlocked",
          "true"
        )
      );
      expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
        "data-client-id",
        "dynamic-client"
      );
      expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
        "data-auth-method",
        "client_secret_basic"
      );
      expect(capturedScorecardProps.input.clientSecret).toBeUndefined();
      expect(capturedScorecardProps.resolveInput()).toEqual(
        expect.objectContaining({
          clientId: "dynamic-client",
          clientSecret: "session-only-secret",
          tokenEndpointAuthMethod: "client_secret_basic",
          issuerKind: "org",
        })
      );
    });

    it("keeps confidential DCR secrets out of the hosted issuer scorecard", async () => {
      runSettingsState = { ...runSettingsState, issuerMode: "hosted" };
      const user = userEvent.setup();
      render(
        <XAAFlowTab
          serverConfigs={withStrategy("dcr")}
          selectedServerName="staging"
          organizationId="org_123"
        />
      );

      const registrationEndpoint = "https://auth.example.com/register";
      const cacheKey = buildXaaDcrCredentialCacheKey({
        targetKey: currentTarget.targetKey,
        registrationEndpoint,
      });
      capturedMachineConfig.dcrCredentialCache.set(cacheKey, {
        clientId: "dynamic-client",
        clientSecret: "session-only-secret",
        clientSecretExpiresAt: 0,
        tokenEndpointAuthMethod: "client_secret_post",
        registrationEndpoint,
      });
      machineCompletionUpdates = {
        registrationStrategy: "dcr",
        clientId: "dynamic-client",
        tokenEndpoint: "https://auth.example.com/token",
        authzMetadata: {
          issuer: "https://auth.example.com",
          registration_endpoint: registrationEndpoint,
        },
        resourceMetadata: { resource: "https://staging.mcp.example.com" },
      };

      await user.click(screen.getByRole("button", { name: /run all/i }));

      await waitFor(() =>
        expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
          "data-unavailable-reason",
          expect.stringMatching(/confidential DCR/i)
        )
      );
      expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
        "data-has-input",
        "false"
      );
      expect(capturedScorecardProps.resolveInput).toBeUndefined();
    });

    it("keeps CIMD negative tests unavailable", async () => {
      const user = userEvent.setup();
      render(
        <XAAFlowTab
          serverConfigs={withStrategy("cimd")}
          selectedServerName="staging"
        />
      );
      const clientId =
        "https://app.mcpjam.com/.well-known/oauth/xaa-client-metadata.json";
      machineCompletionUpdates = {
        registrationStrategy: "cimd",
        clientId,
        tokenEndpoint: "https://auth.example.com/token",
        tokenEndpointAuthMethod: "none",
        authzMetadata: { issuer: "https://auth.example.com" },
        resourceMetadata: { resource: "https://staging.mcp.example.com" },
      };

      await user.click(screen.getByRole("button", { name: /run all/i }));

      await waitFor(() =>
        expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
          "data-unavailable-reason",
          expect.stringMatching(/not supported yet/i)
        )
      );
      expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
        "data-unlocked",
        "false"
      );
      expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
        "data-has-input",
        "false"
      );
      expect(capturedScorecardProps.resolveInput).toBeUndefined();
    });

    it("keeps an expired DCR credential unavailable without registering again", async () => {
      const user = userEvent.setup();
      render(
        <XAAFlowTab
          serverConfigs={withStrategy("dcr")}
          selectedServerName="staging"
        />
      );

      const registrationEndpoint = "https://auth.example.com/register";
      const cacheKey = buildXaaDcrCredentialCacheKey({
        targetKey: currentTarget.targetKey,
        registrationEndpoint,
      });
      capturedMachineConfig.dcrCredentialCache.set(cacheKey, {
        clientId: "expired-client",
        clientSecret: "expired-secret",
        clientSecretExpiresAt: Math.floor(Date.now() / 1000) - 1,
        tokenEndpointAuthMethod: "client_secret_post",
        registrationEndpoint,
      });
      machineCompletionUpdates = {
        registrationStrategy: "dcr",
        clientId: "expired-client",
        tokenEndpoint: "https://auth.example.com/token",
        authzMetadata: {
          issuer: "https://auth.example.com",
          registration_endpoint: registrationEndpoint,
        },
        resourceMetadata: { resource: "https://staging.mcp.example.com" },
      };

      await user.click(screen.getByRole("button", { name: /run all/i }));

      await waitFor(() =>
        expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
          "data-unavailable-reason",
          expect.stringMatching(/expired/i)
        )
      );
      expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
        "data-has-input",
        "false"
      );
      expect(
        screen
          .getByTestId("xaa-scorecard")
          .getAttribute("data-unavailable-reason")
      ).toMatch(/expired/i);
      expect(runAllMock).toHaveBeenCalledTimes(1);
    });

    it("defaults to preregistered when nothing is persisted", () => {
      render(
        <XAAFlowTab
          serverConfigs={{ staging: {} as any }}
          selectedServerName="staging"
        />
      );
      expect(capturedMachineConfig.registrationStrategy).toBe("preregistered");
    });

    it("honors an explicit dcr even with a stored secret, and does NOT send serverId", () => {
      // A stored secret used to downgrade dynamic strategies to preregistered.
      // Now an explicit dcr is honored and the stored serverId/secret is ignored
      // so the browser performs its own dynamic registration.
      currentTarget = makeTarget({
        usesServerSideSecret: true,
        serverId: "srv_1",
        projectId: "proj_1",
      } as Partial<XaaTestTarget>);
      render(
        <XAAFlowTab
          serverConfigs={withStrategy("dcr")}
          selectedServerName="staging"
          projectId="proj_1"
        />
      );
      expect(capturedMachineConfig.registrationStrategy).toBe("dcr");
      expect(capturedMachineConfig.serverId).toBeUndefined();
    });

    it("still sends serverId for a stored-secret preregistered target", () => {
      currentTarget = makeTarget({
        usesServerSideSecret: true,
        serverId: "srv_1",
        projectId: "proj_1",
      } as Partial<XaaTestTarget>);
      render(
        <XAAFlowTab
          serverConfigs={{ staging: {} as any }}
          selectedServerName="staging"
          projectId="proj_1"
        />
      );
      expect(capturedMachineConfig.registrationStrategy).toBe("preregistered");
      expect(capturedMachineConfig.serverId).toBe("srv_1");
    });

    it("prompts to reset when the strategy changes on a completed same-target run", async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <XAAFlowTab
          serverConfigs={{ staging: {} as any }}
          selectedServerName="staging"
        />
      );
      // Drive the run to completion so a later strategy change must confirm.
      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() =>
        expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
          "data-unlocked",
          "true"
        )
      );

      // Persisted strategy changes for the same target → confirm before reset.
      rerender(
        <XAAFlowTab
          serverConfigs={withStrategy("dcr")}
          selectedServerName="staging"
        />
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /keep current run/i })
        ).toBeInTheDocument()
      );

      // Keep the current run, then start a FRESH run: the fresh-run path
      // (Run all → rebuildFlow) must use the newly persisted strategy, not a
      // stale pin. This is the exact path the stale-pin bug regressed.
      await user.click(
        screen.getByRole("button", { name: /keep current run/i })
      );
      // Start a fresh run. On the old pinned code this rebuilt with the stale
      // preregistered strategy; the machine driving Run all must be dcr.
      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() =>
        expect(capturedMachineConfig.registrationStrategy).toBe("dcr")
      );
    });

    it("forces preregistered for registration-backed targets regardless of persisted strategy", () => {
      currentTarget = makeTarget({
        targetSource: "registration",
        runInput: {
          ...makeTarget().runInput,
          registrationId: "app_1",
        },
      } as Partial<XaaTestTarget>);
      render(
        <XAAFlowTab
          serverConfigs={withStrategy("dcr")}
          selectedServerName="staging"
        />
      );
      expect(capturedMachineConfig.registrationStrategy).toBe("preregistered");
    });
  });
});
