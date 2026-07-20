import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { XAAFlowTab } from "../xaa/XAAFlowTab";
import { fetchConfidentialCimdClientUrl } from "@/lib/xaa/idp-endpoints";
import type { XaaTestTarget } from "@/hooks/useXaaTestTarget";
import { buildXaaDcrCredentialCacheKey } from "@/lib/xaa/types";

const runtimeConfig = vi.hoisted(() => ({ hostedMode: false }));
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return runtimeConfig.hostedMode;
  },
}));

const captureMock = vi.fn();
vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => captureMock(...args),
}));

// Controllable signed-in state: null simulates a guest session.
let authUser: { email: string } | null = { email: "tester@example.com" };
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: authUser }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

let capturedIdpCardProps: any = null;
vi.mock("../xaa/XAAIdpCard", () => ({
  XAAIdpCard: (props: any) => {
    capturedIdpCardProps = props;
    return <div data-testid="xaa-idp-card" />;
  },
}));

let capturedServerModalProps: any = null;
vi.mock("../xaa/XAAServerModal", () => ({
  XAAServerModal: (props: any) => {
    capturedServerModalProps = props;
    return <div data-testid="xaa-server-modal" />;
  },
}));

// Controllable resolved target. Each test sets it before render. The params
// the tab passes in are captured so the tab→resolver wiring (e.g. the selected
// person) is assertable despite the wholesale mock.
let currentTarget: XaaTestTarget;
let capturedTargetParams: any = null;
vi.mock("@/hooks/useXaaTestTarget", () => ({
  useXaaTestTarget: (params: any) => {
    capturedTargetParams = params;
    return currentTarget;
  },
}));

// Controllable global run settings (simulated identity + mode). Tests mutate
// runSettingsState then rerender to drive an identity edit.
let runSettingsState: {
  userId: string;
  email: string;
  negativeTestMode: "valid" | "expired" | "wrong_audience" | "bad_signature";
} = { userId: "u", email: "e@example.com", negativeTestMode: "valid" };
let personSelectionState: Record<string, string> = {};
let issuerModeState: "local" | "hosted" = "local";
const setIdentityMock = vi.fn();
const setNegativeTestModeMock = vi.fn();
const setSelectedPersonIdMock = vi.fn();
vi.mock("@/hooks/useXaaRunSettings", () => ({
  useXaaRunSettings: () => ({
    ...runSettingsState,
    issuerMode: issuerModeState,
    selectedPersonIdByProject: personSelectionState,
    isDefaultIdentity: false,
    setIdentity: setIdentityMock,
    setNegativeTestMode: setNegativeTestModeMock,
    setIssuerMode: vi.fn(),
    setSelectedPersonId: setSelectedPersonIdMock,
  }),
}));

// Controllable "Run as" roster. The strip itself is mocked (tested in its own
// suite) — tab tests assert the wiring: selection resolution, reset, and the
// per-person outcome map exposed through outcomeFor.
type TestPerson = {
  _id: string;
  name: string;
  subject: string;
  email: string;
  createdAt: number;
  updatedAt: number;
};
let peopleState: {
  people: TestPerson[] | undefined;
  isLoading: boolean;
  isAvailable: boolean;
} = { people: undefined, isLoading: false, isAvailable: false };
vi.mock("@/hooks/useXaaPeople", () => ({
  useXaaPeople: () => peopleState,
  useXaaPeopleMutations: () => ({
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
}));

let capturedPeopleStripProps: any = null;
vi.mock("../xaa/XAAPeopleStrip", () => ({
  XAAPeopleStrip: (props: any) => {
    capturedPeopleStripProps = props;
    return <div data-testid="xaa-people-strip" />;
  },
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

const captureXaaSequenceProps = vi.hoisted(() => vi.fn());
vi.mock("../xaa/XAASequenceDiagram", () => ({
  XAASequenceDiagram: (props: unknown) => {
    captureXaaSequenceProps(props);
    return <div data-testid="xaa-sequence-diagram" />;
  },
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
      resetDisabled?: boolean;
      isRunningAll?: boolean;
      onContinue?: () => void;
      onRunAll?: () => void;
      onReset?: () => void;
    };
  }) => (
    <div data-testid="xaa-flow-logger">
      <span data-testid="logger-server-url">
        {summary.serverUrl || "No target configured"}
      </span>
      <span data-testid="logger-continue-label">{actions.continueLabel}</span>
      <button
        type="button"
        data-testid="logger-reset"
        disabled={actions.resetDisabled || !actions.onReset}
        onClick={() => actions.onReset?.()}
      >
        Reset
      </button>
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

let capturedScorecardProps: any = null;
let capturedScorecardInput: any = null;
vi.mock("../xaa/NegativeTestScorecard", () => ({
  NegativeTestScorecard: (props: any) => {
    capturedScorecardProps = props;
    capturedScorecardInput = props.input;
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
// Extra fields the fake machine merges into the completed state (e.g. a
// grantedScope for downscoping tests). `machineCompleteExtras` (People tests)
// spreads AFTER completion so it can override; `machineCompletionUpdates`
// (SAML tests) spreads BEFORE so completion fields win. Both default to {}.
let machineCompleteExtras: Record<string, unknown> = {};
let machineCompletionUpdates: Record<string, unknown> = {};
// When set, runAll parks this failure state instead of completing.
let machineFailure: Record<string, unknown> | null = null;
// Controllable confidential-CIMD reflector URL fetch. null ⇒ the fetch failed
// (or hasn't resolved), which must fail the run closed rather than fall back to
// public CIMD. Preserve every other real export so the issuer-resolution paths
// the rest of the suite exercises behave unchanged.
let confidentialCimdUrlResult: string | null = null;
vi.mock("@/lib/xaa/idp-endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/xaa/idp-endpoints")>()),
  fetchConfidentialCimdClientUrl: vi.fn(async () => confidentialCimdUrlResult),
}));

vi.mock("@/lib/xaa/debug-state-machine-adapter", () => ({
  createInspectorXAAStateMachine: (config: any) => {
    capturedMachineConfig = config;
    return {
      proceedToNextStep: vi.fn(),
      // A "successful" run marks the flow complete (fires success telemetry +
      // unlocks the scorecard); an unsuccessful one leaves it mid-flow.
      runAll: vi.fn(async () => {
        runAllMock();
        if (machineFailure) {
          config.updateState({ isBusy: false, ...machineFailure });
        } else if (machineShouldComplete) {
          config.updateState({
            ...machineCompletionUpdates,
            currentStep: "complete",
            isBusy: false,
            ...machineCompleteExtras,
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
    capturedIdpCardProps = null;
    machineShouldComplete = true;
    machineCompleteExtras = {};
    machineCompletionUpdates = {};
    machineFailure = null;
    // Reset like every other module-level mutable: the issuer-kind test flips
    // authUser to null (guest), and a mid-test failure must not leak that into
    // later tests.
    authUser = { email: "tester@example.com" };
    localStorage.clear();
    runSettingsState = {
      userId: "u",
      email: "e@example.com",
      negativeTestMode: "valid",
    };
    personSelectionState = {};
    issuerModeState = "local";
    peopleState = { people: undefined, isLoading: false, isAvailable: false };
    capturedPeopleStripProps = null;
    capturedTargetParams = null;
    capturedScorecardInput = null;
    setIdentityMock.mockClear();
    setNegativeTestModeMock.mockClear();
    setSelectedPersonIdMock.mockClear();
    confidentialCimdUrlResult = null;
    runtimeConfig.hostedMode = false;
    currentTarget = makeTarget();
  });

  it("suppresses the configure prompt when the header has a server", () => {
    currentTarget = makeTarget({
      targetSource: "none",
      targetKey: "none",
      isTestable: false,
    });

    render(
      <XAAFlowTab
        serverConfigs={{}}
        selectedServerName="none"
        hasHeaderServers
      />,
    );

    expect(captureXaaSequenceProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ showConfigurePrompt: false }),
    );
  });

  it("suppresses the configure prompt while project servers hydrate", () => {
    currentTarget = makeTarget({
      targetSource: "none",
      targetKey: "none",
      isTestable: false,
    });

    render(
      <XAAFlowTab
        serverConfigs={{}}
        selectedServerName="none"
        areServersHydrated={false}
      />,
    );

    expect(captureXaaSequenceProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ showConfigurePrompt: false }),
    );
  });

  const CONFIDENTIAL_SERVER = {
    staging: { registrationMode: "cimd", xaaClientAuth: "private_key_jwt" },
  } as any;

  it("fails a confidential CIMD run closed when the reflector URL can't load", async () => {
    const user = userEvent.setup();
    confidentialCimdUrlResult = null; // fetch fails
    render(
      <XAAFlowTab
        serverConfigs={CONFIDENTIAL_SERVER}
        selectedServerName="staging"
      />
    );

    await user.click(screen.getByRole("button", { name: /run all/i }));

    // Blocked: the machine is NOT run, and it was never configured as public
    // CIMD (no clientIdMetadataUrl) that would omit the client_assertion.
    expect(runAllMock).not.toHaveBeenCalled();
    expect(capturedMachineConfig?.clientIdMetadataUrl).toBeUndefined();
  });

  it("preserves a hosted confidential config after a probe error and retries on run", async () => {
    const user = userEvent.setup();
    runtimeConfig.hostedMode = true;
    confidentialCimdUrlResult = null; // first fetch fails
    render(
      <XAAFlowTab
        serverConfigs={CONFIDENTIAL_SERVER}
        selectedServerName="staging"
        organizationId="org_123"
      />
    );
    await waitFor(() =>
      expect(fetchConfidentialCimdClientUrl).toHaveBeenCalled()
    );
    const callsBefore = vi.mocked(fetchConfidentialCimdClientUrl).mock.calls
      .length;

    await user.click(screen.getByRole("button", { name: /run all/i }));

    await waitFor(() =>
      expect(
        vi.mocked(fetchConfidentialCimdClientUrl).mock.calls.length
      ).toBeGreaterThan(callsBefore)
    );
    expect(capturedServerModalProps.confidentialCimdAvailable).toBe(false);
    expect(
      capturedServerModalProps.preserveConfidentialCimdSelection
    ).toBe(true);
    expect(runAllMock).not.toHaveBeenCalled();
  });

  it("threads the reflector URL into the machine for a confidential CIMD run", async () => {
    const user = userEvent.setup();
    const reflectorUrl =
      "https://app.mcpjam.com/.well-known/oauth/xaa-cimd/AbC123";
    confidentialCimdUrlResult = reflectorUrl;
    render(
      <XAAFlowTab
        serverConfigs={CONFIDENTIAL_SERVER}
        selectedServerName="staging"
      />
    );

    await waitFor(() =>
      expect(capturedMachineConfig?.clientIdMetadataUrl).toBe(reflectorUrl)
    );
    await user.click(screen.getByRole("button", { name: /run all/i }));
    expect(runAllMock).toHaveBeenCalled();
  });

  it("keeps a hosted public CIMD run public after capability discovery", async () => {
    runtimeConfig.hostedMode = true;
    confidentialCimdUrlResult =
      "https://app.mcpjam.com/.well-known/oauth/xaa-cimd/AbC123";

    render(
      <XAAFlowTab
        serverConfigs={{
          staging: { registrationMode: "cimd", xaaClientAuth: "none" },
        } as any}
        selectedServerName="staging"
        organizationId="org_123"
      />
    );

    await waitFor(() =>
      expect(capturedServerModalProps.confidentialCimdAvailable).toBe(true)
    );
    expect(capturedMachineConfig.registrationStrategy).toBe("cimd");
    expect(capturedMachineConfig.clientIdMetadataUrl).toBeUndefined();
    expect(capturedMachineConfig.allowLoopbackClientMetadata).toBeUndefined();
  });

  it("preserves an existing hosted confidential config while capability is loading", async () => {
    runtimeConfig.hostedMode = true;
    // Modal persistence must follow the saved config even when the target is
    // temporarily not runnable (for example, while fixing an unrelated URL).
    currentTarget = makeTarget({ isTestable: false });
    let resolveCapability: ((url: string) => void) | undefined;
    vi.mocked(fetchConfidentialCimdClientUrl).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveCapability = resolve;
        })
    );

    const { unmount } = render(
      <XAAFlowTab
        serverConfigs={CONFIDENTIAL_SERVER}
        selectedServerName="staging"
        organizationId="org_123"
      />
    );

    await waitFor(() =>
      expect(fetchConfidentialCimdClientUrl).toHaveBeenCalled()
    );
    expect(capturedServerModalProps.confidentialCimdAvailable).toBe(false);
    expect(
      capturedServerModalProps.preserveConfidentialCimdSelection
    ).toBe(true);

    // Avoid leaving an unresolved effect behind after the assertion.
    resolveCapability?.(
      "https://app.mcpjam.com/.well-known/oauth/xaa-cimd/AbC123"
    );
    unmount();
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
    expect(viewed[0][1]).toMatchObject({ target_count: 2 });
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

    it("keeps the DCR session registration when the same config is saved", async () => {
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
      const credentials = {
        clientId: "dynamic-client",
        clientSecret: "session-only-secret",
        clientSecretExpiresAt: 0,
        tokenEndpointAuthMethod: "client_secret_basic" as const,
        registrationEndpoint,
      };
      capturedMachineConfig.dcrCredentialCache.set(cacheKey, credentials);

      await act(async () => {
        await capturedServerModalProps.onSave({
          formData: { name: "staging" },
        });
      });

      expect(capturedMachineConfig.dcrCredentialCache.get(cacheKey)).toEqual(
        credentials
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

      capturedMachineConfig.dcrCredentialCache.set(cacheKey, {
        clientId: "dynamic-client",
        clientSecret: "session-only-secret",
        clientSecretExpiresAt: 0,
        tokenEndpointAuthMethod: "client_secret_post",
        registrationEndpoint,
      });
      act(() => {
        capturedMachineConfig.updateState({
          tokenEndpointAuthMethod: "client_secret_post",
        });
      });

      await waitFor(() =>
        expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
          "data-unlocked",
          "false"
        )
      );
      expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
        "data-auth-method",
        "client_secret_post"
      );
    });

    it("preserves the duplicate-registration warning across config edits", async () => {
      const { rerender } = render(
        <XAAFlowTab
          serverConfigs={withStrategy("dcr")}
          selectedServerName="staging"
        />
      );

      act(() => {
        capturedMachineConfig.updateState({
          registrationStrategy: "dcr",
          currentStep: "dcr_request",
          isBusy: false,
          error: "Registration outcome unknown",
          dcrRetryMayCreateDuplicate: true,
        });
      });

      currentTarget = makeTarget({
        runInput: {
          ...makeTarget().runInput,
          scope: "new-scope",
        },
      });
      rerender(
        <XAAFlowTab
          serverConfigs={withStrategy("dcr")}
          selectedServerName="staging"
        />
      );

      await waitFor(() =>
        expect(
          capturedMachineConfig.getState().dcrRetryMayCreateDuplicate
        ).toBe(true)
      );
    });

    // Confidential DCR now runs on the hosted issuer: the server mints on
    // hosted and redeems locally, so the client builds a normal input (secret
    // supplied at click time via resolveInput) and the secret-never-reaches-
    // hosted guarantee is enforced server-side, not by blocking here.
    it("allows confidential DCR on the hosted issuer, supplying the secret at click time", async () => {
      issuerModeState = "hosted";
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
          "data-unlocked",
          "true"
        )
      );
      const scorecard = screen.getByTestId("xaa-scorecard");
      expect(scorecard).toHaveAttribute("data-has-input", "true");
      expect(scorecard).toHaveAttribute("data-unavailable-reason", "");
      // The base input never carries the secret; resolveInput adds it fresh.
      expect(capturedScorecardInput.clientSecret).toBeUndefined();
      const resolved = capturedScorecardProps.resolveInput();
      expect(resolved.clientSecret).toBe("session-only-secret");
    });

    // The CIMD client identity is the metadata document URL the run resolved,
    // and the auth method comes from the document it validated — so the
    // scorecard reads both straight off flow state.
    it.each([
      {
        variant: "public",
        clientId:
          "https://app.mcpjam.com/.well-known/oauth/xaa-client-metadata.json",
        authMethod: "none" as const,
      },
      {
        variant: "confidential",
        clientId: "https://app.mcpjam.com/.well-known/oauth/xaa-cimd/AbC123",
        authMethod: "private_key_jwt" as const,
      },
    ])(
      "runs $variant CIMD negative tests against the run's URL client_id",
      async ({ clientId, authMethod }) => {
        const user = userEvent.setup();
        render(
          <XAAFlowTab
            serverConfigs={withStrategy("cimd")}
            selectedServerName="staging"
          />
        );
        machineCompletionUpdates = {
          registrationStrategy: "cimd",
          clientId,
          tokenEndpoint: "https://auth.example.com/token",
          tokenEndpointAuthMethod: authMethod,
          authzMetadata: { issuer: "https://auth.example.com" },
          resourceMetadata: { resource: "https://staging.mcp.example.com" },
        };

        await user.click(screen.getByRole("button", { name: /run all/i }));

        await waitFor(() =>
          expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
            "data-unlocked",
            "true"
          )
        );
        const scorecard = screen.getByTestId("xaa-scorecard");
        expect(scorecard).toHaveAttribute("data-has-input", "true");
        expect(scorecard).toHaveAttribute("data-unavailable-reason", "");
        expect(scorecard).toHaveAttribute("data-client-id", clientId);
        expect(scorecard).toHaveAttribute("data-auth-method", authMethod);
        // No secret exists for a CIMD client — the server signs the
        // client_assertion for private_key_jwt, so there is nothing to re-read
        // at click time the way a DCR run must.
        expect(capturedScorecardInput.clientSecret).toBeUndefined();
        expect(capturedScorecardProps.resolveInput).toBeUndefined();
      }
    );

    it("keeps CIMD negative tests unavailable until the flow has run", async () => {
      render(
        <XAAFlowTab
          serverConfigs={withStrategy("cimd")}
          selectedServerName="staging"
        />
      );

      await waitFor(() =>
        expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
          "data-unavailable-reason",
          expect.stringMatching(/run the flow first/i)
        )
      );
      expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
        "data-has-input",
        "false"
      );
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

  });

  describe("identity assertion header toggle (write-through)", () => {
    // A realistic stored XAA server: the toggle's untouched resave derives
    // url/clientId/scopes from the config and must preserve the rest of the
    // stored values by omission.
    const storedServer = () =>
      ({
        staging: {
          name: "staging",
          config: { url: "https://staging.mcp.example.com" },
          hasClientSecret: false,
          xaaAuthzIssuer: "https://as.example.com",
          // Stored "auto" is shared with the OAuth flow — the resave must
          // omit registrationMode so the save-path merge preserves it.
          registrationMode: "auto",
          xaaSubject: "stored-subject",
          xaaEmail: "stored@example.com",
        },
      } as any);

    it("passes the persisted format and an enabled control for a testable bar server", () => {
      render(
        <XAAFlowTab
          serverConfigs={{
            staging: {
              ...storedServer().staging,
              xaaIdentityAssertionFormat: "saml",
            },
          }}
          selectedServerName="staging"
          onSaveServerConfig={vi.fn()}
        />
      );

      expect(capturedIdpCardProps.identityAssertionFormat).toBe("saml");
      expect(capturedIdpCardProps.onIdentityAssertionFormatChange).toEqual(
        expect.any(Function)
      );
      expect(
        capturedIdpCardProps.identityAssertionFormatDisabledReason
      ).toBeNull();
    });

    it("persists a flip to SAML through the modal's save path, preserving stored fields by omission", async () => {
      const onSaveServerConfig = vi.fn();
      render(
        <XAAFlowTab
          serverConfigs={storedServer()}
          selectedServerName="staging"
          onSaveServerConfig={onSaveServerConfig}
        />
      );

      await act(async () => {
        await capturedIdpCardProps.onIdentityAssertionFormatChange("saml");
      });

      expect(onSaveServerConfig).toHaveBeenCalledTimes(1);
      const formData = onSaveServerConfig.mock.calls[0][0];
      expect(formData).toMatchObject({
        name: "staging",
        type: "http",
        url: "https://staging.mcp.example.com",
        useXaa: true,
        useOAuth: false,
        authServerMode: "mcpjam",
        xaaAuthzIssuer: "https://as.example.com",
        xaaIdentityAssertionFormat: "saml",
      });
      // Preserve-by-omission: the format is the ONLY stored value this save
      // may change. Sending any of these would clobber stored state (identity
      // pair, shared "auto" registration mode) or the saved secret.
      expect(formData).not.toHaveProperty("xaaSubject");
      expect(formData).not.toHaveProperty("xaaEmail");
      expect(formData).not.toHaveProperty("registrationMode");
      expect(formData).not.toHaveProperty("clientSecret");
      expect(formData).not.toHaveProperty("clearClientSecret");
    });

    it("does not save when the selected format is already active", async () => {
      const onSaveServerConfig = vi.fn();
      render(
        <XAAFlowTab
          serverConfigs={storedServer()}
          selectedServerName="staging"
          onSaveServerConfig={onSaveServerConfig}
        />
      );

      await act(async () => {
        await capturedIdpCardProps.onIdentityAssertionFormatChange("oidc");
      });
      expect(onSaveServerConfig).not.toHaveBeenCalled();
    });

    it("hides the control when no save path is wired", () => {
      render(
        <XAAFlowTab serverConfigs={storedServer()} selectedServerName="staging" />
      );
      expect(
        capturedIdpCardProps.onIdentityAssertionFormatChange
      ).toBeUndefined();
    });
  });

  describe("Run as people", () => {
    const bob: TestPerson = {
      _id: "person_bob",
      name: "Bob Tables",
      subject: "bob-001",
      email: "bob@tables.test",
      createdAt: 1,
      updatedAt: 10,
    };

    function seedRoster(selected = true) {
      peopleState = { people: [bob], isLoading: false, isAvailable: true };
      if (selected) personSelectionState = { proj_1: bob._id };
    }

    /** Target whose runInput carries the person's identity (the real
     * useXaaTestTarget is mocked wholesale, so tests set it themselves). */
    function personTarget(extra: Record<string, unknown> = {}) {
      return makeTarget({
        runInput: {
          ...makeTarget().runInput,
          userId: bob.subject,
          email: bob.email,
          ...extra,
        },
      } as Partial<XaaTestTarget>);
    }

    function renderTab() {
      return render(
        <XAAFlowTab
          serverConfigs={{}}
          selectedServerName="staging"
          projectId="proj_1"
        />,
      );
    }

    it("passes selection through and toggling calls the per-project setter", () => {
      seedRoster();
      currentTarget = personTarget();
      renderTab();

      expect(capturedPeopleStripProps.selectedPersonId).toBe(bob._id);
      expect(capturedPeopleStripProps.disabled).toBe(false);
      capturedPeopleStripProps.onSelectPerson(null);
      expect(setSelectedPersonIdMock).toHaveBeenCalledWith("proj_1", null);
    });

    it("a person switch resets a completed flow immediately (no debounce)", async () => {
      const user = userEvent.setup();
      peopleState = { people: [bob], isLoading: false, isAvailable: true };
      const { rerender } = renderTab();

      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() =>
        expect(screen.getByTestId("logger-continue-label")).toHaveTextContent(
          "Flow Complete",
        ),
      );

      // Select Bob: selection + the resolved runInput identity change together.
      personSelectionState = { proj_1: bob._id };
      currentTarget = personTarget();
      rerender(
        <XAAFlowTab
          serverConfigs={{}}
          selectedServerName="staging"
          projectId="proj_1"
        />,
      );

      // Synchronous reset — back to Start without waiting out the 400ms
      // debounce that typed identity edits use.
      expect(screen.getByTestId("logger-continue-label")).toHaveTextContent(
        "Start",
      );
    });

    it("ignores selection changes while the flow is busy", () => {
      seedRoster(false);
      currentTarget = makeTarget();
      renderTab();

      act(() => {
        capturedMachineConfig.updateState({ isBusy: true });
      });
      expect(capturedPeopleStripProps.disabled).toBe(true);
      // Backstop even if the strip's disabled state were bypassed.
      capturedPeopleStripProps.onSelectPerson(bob._id);
      expect(setSelectedPersonIdMock).not.toHaveBeenCalled();
    });

    it("ignores selection changes while a step-through run is PAUSED mid-flow", () => {
      // A Continue-driven run parks between steps with isBusy=false but the
      // flow neither idle nor complete — switching persons there would
      // silently drop the in-progress state (coderabbit finding).
      seedRoster(false);
      currentTarget = makeTarget();
      renderTab();

      act(() => {
        capturedMachineConfig.updateState({
          isBusy: false,
          currentStep: "token_exchange_request",
        });
      });
      expect(capturedPeopleStripProps.disabled).toBe(true);
      // Backstop for the programmatic seam too.
      capturedPeopleStripProps.onSelectPerson(bob._id);
      expect(setSelectedPersonIdMock).not.toHaveBeenCalled();
    });

    it("records 'allowed' for the person the run started as", async () => {
      const user = userEvent.setup();
      seedRoster();
      currentTarget = personTarget();
      renderTab();

      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() =>
        expect(capturedPeopleStripProps.outcomeFor(bob._id)).toMatchObject({
          status: "allowed",
        }),
      );
    });

    it("records 'ras_downscoped' when the AS granted a narrower scope", async () => {
      const user = userEvent.setup();
      seedRoster();
      currentTarget = personTarget({ scope: "tasks:read tasks:write" });
      machineCompleteExtras = { grantedScope: "tasks:read" };
      renderTab();

      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() =>
        expect(capturedPeopleStripProps.outcomeFor(bob._id)).toMatchObject({
          status: "ras_downscoped",
        }),
      );
    });

    it("records 'ras_rejected' with the allowlisted code — never the raw error", async () => {
      const user = userEvent.setup();
      seedRoster();
      currentTarget = personTarget();
      machineFailure = {
        currentStep: "jwt_bearer_request",
        error:
          "Authorization server returned 400 (invalid_grant: subject not provisioned; token=SECRET). Does the authorization server trust the synthetic issuer JWKS?",
      };
      renderTab();

      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() =>
        expect(capturedPeopleStripProps.outcomeFor(bob._id)).toMatchObject({
          status: "ras_rejected",
          oauthErrorCode: "invalid_grant",
          failedStep: "jwt_bearer_request",
        }),
      );
      // The recorded outcome must never carry the raw error string (it can
      // embed tokens) — only the allowlisted code and step enum.
      const recorded = capturedPeopleStripProps.outcomeFor(bob._id);
      expect(JSON.stringify(recorded)).not.toContain("SECRET");
      expect(JSON.stringify(recorded)).not.toContain("provisioned");
    });

    it("records 'test_error' for a non-policy failure", async () => {
      const user = userEvent.setup();
      seedRoster();
      currentTarget = personTarget();
      machineFailure = {
        currentStep: "discover_authz_metadata",
        error: "fetch failed: network unreachable",
      };
      renderTab();

      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() =>
        expect(capturedPeopleStripProps.outcomeFor(bob._id)).toMatchObject({
          status: "test_error",
          failedStep: "discover_authz_metadata",
        }),
      );
    });

    it("records nothing for a negative-mode run", async () => {
      const user = userEvent.setup();
      seedRoster();
      currentTarget = personTarget({ negativeTestMode: "expired" });
      renderTab();

      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() => expect(runAllMock).toHaveBeenCalledTimes(1));
      expect(capturedPeopleStripProps.outcomeFor(bob._id)).toBeUndefined();
    });

    it("hides a recorded outcome when the target's material inputs change", async () => {
      const user = userEvent.setup();
      seedRoster();
      currentTarget = personTarget();
      const { rerender } = renderTab();

      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() =>
        expect(capturedPeopleStripProps.outcomeFor(bob._id)).toBeDefined(),
      );

      currentTarget = personTarget({
        serverUrl: "https://other.mcp.example.com",
      });
      rerender(
        <XAAFlowTab
          serverConfigs={{}}
          selectedServerName="staging"
          projectId="proj_1"
        />,
      );
      expect(capturedPeopleStripProps.outcomeFor(bob._id)).toBeUndefined();
    });

    it("hides a recorded outcome after the person is edited", async () => {
      const user = userEvent.setup();
      seedRoster();
      currentTarget = personTarget();
      const { rerender } = renderTab();

      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() =>
        expect(capturedPeopleStripProps.outcomeFor(bob._id)).toBeDefined(),
      );

      // Editing the person bumps updatedAt — the old result may no longer
      // describe this subject.
      peopleState = {
        ...peopleState,
        people: [{ ...bob, subject: "bob-999", updatedAt: 11 }],
      };
      rerender(
        <XAAFlowTab
          serverConfigs={{}}
          selectedServerName="staging"
          projectId="proj_1"
        />,
      );
      expect(capturedPeopleStripProps.outcomeFor(bob._id)).toBeUndefined();
    });

    it("invalidates a recorded outcome when the registration strategy switches (fix F)", async () => {
      const user = userEvent.setup();
      seedRoster();
      currentTarget = personTarget();
      const { rerender } = render(
        <XAAFlowTab
          serverConfigs={{ staging: {} as any }}
          selectedServerName="staging"
          projectId="proj_1"
        />,
      );

      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() =>
        expect(capturedPeopleStripProps.outcomeFor(bob._id)).toMatchObject({
          status: "allowed",
        }),
      );

      // The persisted strategy flips to DCR for the same target — a
      // preregistered result must not stay attributed to a different client
      // identity. The completed run asks for confirmation first.
      rerender(
        <XAAFlowTab
          serverConfigs={{ staging: { registrationMode: "dcr" } } as any}
          selectedServerName="staging"
          projectId="proj_1"
        />,
      );
      await user.click(
        await screen.findByRole("button", { name: /switch and reset/i }),
      );
      expect(capturedPeopleStripProps.outcomeFor(bob._id)).toBeUndefined();
    });

    it("invalidates a dynamic run's outcome when a NEW client identity is registered (fix F)", async () => {
      const user = userEvent.setup();
      seedRoster();
      currentTarget = personTarget();
      // A DCR run that registers a fresh client mid-flight and completes.
      machineCompleteExtras = { clientId: "dyn-client-1" };
      render(
        <XAAFlowTab
          serverConfigs={{ staging: { registrationMode: "dcr" } } as any}
          selectedServerName="staging"
          projectId="proj_1"
        />,
      );

      await user.click(screen.getByRole("button", { name: /run all/i }));
      // The run's own outcome is attributed to the identity it established.
      await waitFor(() =>
        expect(capturedPeopleStripProps.outcomeFor(bob._id)).toMatchObject({
          status: "allowed",
        }),
      );

      // A re-registration establishes a different client identity — the
      // previous result no longer describes it.
      act(() => {
        capturedMachineConfig.updateState({ clientId: "dyn-client-2" });
      });
      expect(capturedPeopleStripProps.outcomeFor(bob._id)).toBeUndefined();
    });

    it("keeps a dynamic outcome across an ordinary reset that reuses the cached registration", async () => {
      const user = userEvent.setup();
      seedRoster();
      currentTarget = personTarget();
      machineCompleteExtras = { clientId: "dyn-client-1" };
      render(
        <XAAFlowTab
          serverConfigs={{ staging: { registrationMode: "dcr" } } as any}
          selectedServerName="staging"
          projectId="proj_1"
        />,
      );

      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() =>
        expect(capturedPeopleStripProps.outcomeFor(bob._id)).toMatchObject({
          status: "allowed",
        }),
      );

      // An ordinary reset re-seeds the CONFIGURED clientId; the session cache
      // still holds the registration, so no new client identity is
      // established and the badge must survive the reset.
      await user.click(screen.getByTestId("logger-reset"));
      expect(screen.getByTestId("logger-continue-label")).toHaveTextContent(
        "Start",
      );
      expect(capturedPeopleStripProps.outcomeFor(bob._id)).toMatchObject({
        status: "allowed",
      });
    });

    it("a re-registration on one target leaves another target's dynamic badge intact (per-target generation)", async () => {
      const user = userEvent.setup();
      seedRoster();
      const dcrConfigs = {
        staging: { registrationMode: "dcr" },
        prod: { registrationMode: "dcr" },
      } as any;
      currentTarget = personTarget();
      machineCompleteExtras = { clientId: "dyn-client-1" };
      const { rerender } = render(
        <XAAFlowTab
          serverConfigs={dcrConfigs}
          selectedServerName="staging"
          projectId="proj_1"
        />,
      );

      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() =>
        expect(capturedPeopleStripProps.outcomeFor(bob._id)).toMatchObject({
          status: "allowed",
        }),
      );

      // Switch to a different DCR target (confirming away the completed run)…
      currentTarget = makeTarget({
        targetKey: "bar_server:prod",
        runInput: {
          ...personTarget().runInput,
          serverUrl: "https://prod.mcp.example.com",
        },
      });
      rerender(
        <XAAFlowTab
          serverConfigs={dcrConfigs}
          selectedServerName="prod"
          projectId="proj_1"
        />,
      );
      await user.click(
        await screen.findByRole("button", { name: /switch and reset/i }),
      );
      // …where a run establishes a NEW dynamic client identity.
      act(() => {
        capturedMachineConfig.updateState({ clientId: "dyn-client-2" });
      });

      // Back on the first target, the recorded outcome still describes the
      // client that produced it — the other target's registration must not
      // invalidate it.
      currentTarget = personTarget();
      rerender(
        <XAAFlowTab
          serverConfigs={dcrConfigs}
          selectedServerName="staging"
          projectId="proj_1"
        />,
      );
      expect(capturedPeopleStripProps.outcomeFor(bob._id)).toMatchObject({
        status: "allowed",
      });
    });

    it("clears a stale stored selection only after the roster loads without it", () => {
      peopleState = { people: [bob], isLoading: true, isAvailable: true };
      personSelectionState = { proj_1: "person_ghost" };
      currentTarget = makeTarget();
      const { rerender } = renderTab();

      // Still loading — must not clear (would wipe a valid selection on
      // every mount).
      expect(setSelectedPersonIdMock).not.toHaveBeenCalled();

      peopleState = { people: [bob], isLoading: false, isAvailable: true };
      rerender(
        <XAAFlowTab
          serverConfigs={{}}
          selectedServerName="staging"
          projectId="proj_1"
        />,
      );
      expect(setSelectedPersonIdMock).toHaveBeenCalledWith("proj_1", null);
    });
  });

});
