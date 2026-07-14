import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { XAAFlowTab } from "../xaa/XAAFlowTab";
import type { XaaTestTarget } from "@/hooks/useXaaTestTarget";

const captureMock = vi.fn();
vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => captureMock(...args),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { email: "tester@example.com" } }),
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
} = { userId: "u", email: "e@example.com", negativeTestMode: "valid" };
let personSelectionState: Record<string, string> = {};
const setIdentityMock = vi.fn();
const setNegativeTestModeMock = vi.fn();
const setSelectedPersonIdMock = vi.fn();
vi.mock("@/hooks/useXaaRunSettings", () => ({
  useXaaRunSettings: () => ({
    ...runSettingsState,
    issuerMode: "local",
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

vi.mock("../xaa/NegativeTestScorecard", () => ({
  NegativeTestScorecard: ({ unlocked }: { unlocked: boolean }) => (
    <div data-testid="xaa-scorecard" data-unlocked={String(unlocked)} />
  ),
}));

const runAllMock = vi.fn();
let capturedMachineConfig: any = null;
let machineShouldComplete = true;
// Extra fields the fake machine merges into the completed state (e.g. a
// grantedScope for downscoping tests).
let machineCompleteExtras: Record<string, unknown> = {};
// When set, runAll parks this failure state instead of completing.
let machineFailure: Record<string, unknown> | null = null;
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
    machineShouldComplete = true;
    machineCompleteExtras = {};
    machineFailure = null;
    resourceApps = [];
    localStorage.clear();
    runSettingsState = {
      userId: "u",
      email: "e@example.com",
      negativeTestMode: "valid",
    };
    personSelectionState = {};
    peopleState = { people: undefined, isLoading: false, isAvailable: false };
    capturedPeopleStripProps = null;
    setIdentityMock.mockClear();
    setNegativeTestModeMock.mockClear();
    setSelectedPersonIdMock.mockClear();
    currentTarget = makeTarget();
  });

  it("shows the not-testable state naming the server, with a configure CTA", () => {
    currentTarget = makeTarget({ isTestable: false });

    render(
      <XAAFlowTab serverConfigs={{}} selectedServerName="local-stdio" />,
    );

    expect(screen.getByText(/Not XAA-compatible/i)).toBeInTheDocument();
    // The card names the selected server and points at the config modal.
    expect(screen.getByText("local-stdio")).toBeInTheDocument();
    expect(
      screen.getByText(/needs an HTTP URL and OAuth/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /configure server to test/i }),
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
      />,
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

  it("a debounced identity reset can't wipe a run started within its window", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <XAAFlowTab serverConfigs={{}} selectedServerName="staging" />,
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
      "Flow Complete",
    );

    // Let the debounce elapse: the stale timer must skip (Run all already
    // applied this identity) rather than rebuild and wipe the completed run.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.getByTestId("logger-continue-label")).toHaveTextContent(
      "Flow Complete",
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

  it("blocks Run (no empty-secret request) when a confidential secret can't be resolved", () => {
    currentTarget = makeTarget({
      usesServerSideSecret: true,
      secretUnavailable: true,
      serversLoading: false,
      serverId: undefined,
    });
    render(<XAAFlowTab serverConfigs={{}} selectedServerName="staging" />);

    expect(
      screen.getByRole("button", { name: /run all/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/couldn't resolve this server's saved secret/i),
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
      screen.getByText(/resolving this server's saved secret/i),
    ).toBeInTheDocument();
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
      screen.getByText(/Using registered app — overrides the bar selection/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /use bar server/i }),
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
      />,
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
      ([event]) => event === "xaa_flow_started",
    );
    expect(started?.[1].target_id).toMatch(/^[0-9a-f]{8}$/);
    expect(started?.[1].target_id).not.toContain("staging");
  });

  it("fires xaa_flow_completed with target_source at both the success and failure sites", async () => {
    const user = userEvent.setup();

    // Success site: the run reaches complete (effect-driven event).
    machineShouldComplete = true;
    const { unmount } = render(
      <XAAFlowTab serverConfigs={{}} selectedServerName="staging" />,
    );
    await user.click(screen.getByRole("button", { name: /run all/i }));
    await waitFor(() =>
      expect(captureMock).toHaveBeenCalledWith(
        "xaa_flow_completed",
        expect.objectContaining({ success: true, target_source: "bar_server" }),
      ),
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
        }),
      ),
    );
  });

  describe("registration strategy (persisted, modal-owned)", () => {
    // The on-flow selector band was removed: the strategy is chosen in the
    // Configure Server modal and persisted on the server config. The flow reads
    // it from serverConfigs[selectedServerName].registrationMode.
    const withStrategy = (strategy: string) =>
      ({ staging: { registrationMode: strategy } }) as any;

    it("threads a persisted dcr strategy to the machine, with the session cache", () => {
      render(
        <XAAFlowTab
          serverConfigs={withStrategy("dcr")}
          selectedServerName="staging"
        />,
      );

      // No on-flow selector band any more.
      expect(
        screen.queryByText(/client registration/i),
      ).not.toBeInTheDocument();
      expect(capturedMachineConfig.registrationStrategy).toBe("dcr");
      expect(capturedMachineConfig.dcrCredentialCache).toBeDefined();
      expect(capturedMachineConfig.dcrCacheTargetKey).toBe(
        currentTarget.targetKey,
      );
    });

    it("defaults to preregistered when nothing is persisted", () => {
      render(
        <XAAFlowTab
          serverConfigs={{ staging: {} as any }}
          selectedServerName="staging"
        />,
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
        />,
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
        />,
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
        />,
      );
      // Drive the run to completion so a later strategy change must confirm.
      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() =>
        expect(screen.getByTestId("xaa-scorecard")).toHaveAttribute(
          "data-unlocked",
          "true",
        ),
      );

      // Persisted strategy changes for the same target → confirm before reset.
      rerender(
        <XAAFlowTab
          serverConfigs={withStrategy("dcr")}
          selectedServerName="staging"
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /keep current run/i }),
        ).toBeInTheDocument(),
      );

      // Keep the current run, then start a FRESH run: the fresh-run path
      // (Run all → rebuildFlow) must use the newly persisted strategy, not a
      // stale pin. This is the exact path the stale-pin bug regressed.
      await user.click(
        screen.getByRole("button", { name: /keep current run/i }),
      );
      // Start a fresh run. On the old pinned code this rebuilt with the stale
      // preregistered strategy; the machine driving Run all must be dcr.
      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() =>
        expect(capturedMachineConfig.registrationStrategy).toBe("dcr"),
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
        />,
      );
      expect(capturedMachineConfig.registrationStrategy).toBe("preregistered");
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

    it("records 'downscoped' when the AS granted a narrower scope", async () => {
      const user = userEvent.setup();
      seedRoster();
      currentTarget = personTarget({ scope: "tasks:read tasks:write" });
      machineCompleteExtras = { grantedScope: "tasks:read" };
      renderTab();

      await user.click(screen.getByRole("button", { name: /run all/i }));
      await waitFor(() =>
        expect(capturedPeopleStripProps.outcomeFor(bob._id)).toMatchObject({
          status: "downscoped",
        }),
      );
    });

    it("records 'rejected' with the allowlisted code — never the raw error", async () => {
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
          status: "rejected",
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

