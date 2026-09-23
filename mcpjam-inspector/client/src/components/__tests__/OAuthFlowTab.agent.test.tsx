/**
 * OAuthFlowTab agent bridge handlers, dispatched through the REAL command bus
 * against a mounted tab (fake state machine, stubbed children).
 *
 * Findings this pins:
 * - advance replicates the Continue button's gates: no profile →
 *   invalid_request; step in flight → execution_failed (retryable); complete →
 *   invalid_request;
 * - at the PKCE step it advances FIRST (generating authorizationUrl), then
 *   opens the human auth modal and reports authorization_modal_opened — the
 *   machine is NOT advanced past the authorization step;
 * - a normal advance reports the post-step state read through the
 *   synchronously-synced ref (previousStep/currentStep/httpStatus), with only
 *   an allowlisted OAuth error code, never raw error text;
 * - openOauthServerConfig prefills via agentSeed + mode and rejects a name
 *   that matches a different existing server;
 * - the surface snapshot never leaks token material and strips sequence steps
 *   to id/label.
 */
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeInspectorCommand } from "@/lib/inspector-command-handlers";
import { readSurfaceSnapshot } from "@/lib/webmcp/surface-snapshot-registry";
import type {
  InspectorCommand,
  InspectorCommandResponse,
} from "@/shared/inspector-command.js";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { OAuthFlowState } from "@mcpjam/sdk/browser";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const STEP_ORDER_FOR_TEST = [
  "idle",
  "request_without_token",
  "generate_pkce_parameters",
  "authorization_request",
  "token_request",
  "complete",
];

vi.mock("@mcpjam/sdk/browser", () => ({
  EMPTY_OAUTH_FLOW_STATE: {
    currentStep: "idle",
    isInitiatingAuth: false,
    httpHistory: [],
    infoLogs: [],
  },
  getStepIndex: (step: string) => {
    const index = STEP_ORDER_FOR_TEST.indexOf(step);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  },
  getSupportedRegistrationStrategies: (version: string) =>
    version === "2025-03-26"
      ? ["dcr", "preregistered"]
      : ["cimd", "dcr", "preregistered"],
  buildOAuthSequenceActions: () => [
    {
      id: "request_without_token",
      label: "MCP request without token",
      description: "Contains SENTINEL_DIAGRAM_DETAIL",
      details: [{ label: "url", value: "SENTINEL_DIAGRAM_DETAIL" }],
    },
  ],
}));

// Fake machine: proceedToNextStep applies whatever the test scripted through
// the component's own updateState (the synced-ref write path under test).
const machineCtl = vi.hoisted(() => ({
  onAdvance: null as
    | ((
        update: (u: Partial<OAuthFlowState>) => void,
        getState: () => OAuthFlowState,
      ) => void)
    | null,
  updateState: null as ((u: Partial<OAuthFlowState>) => void) | null,
}));

vi.mock("@/lib/oauth/debug-state-machine-adapter", () => ({
  createInspectorOAuthStateMachine: (opts: {
    updateState: (u: Partial<OAuthFlowState>) => void;
    getState: () => OAuthFlowState;
  }) => {
    machineCtl.updateState = opts.updateState;
    return {
      proceedToNextStep: async () => {
        machineCtl.onAdvance?.(opts.updateState, opts.getState);
      },
    };
  },
}));

vi.mock("@/components/oauth/OAuthSequenceDiagram", () => ({
  OAuthSequenceDiagram: () => <div data-testid="oauth-sequence-diagram" />,
}));

const captureAuthModalProps = vi.hoisted(() => vi.fn());
// Called once per mount: the real modal opens its popup only on mount or an
// `open` false->true transition, so a remount is what guarantees a new popup.
const captureAuthModalMount = vi.hoisted(() => vi.fn());
vi.mock("@/components/oauth/OAuthAuthorizationModal", async () => {
  const { useEffect } = await import("react");
  return {
    OAuthAuthorizationModal: (props: unknown) => {
      useEffect(() => {
        captureAuthModalMount(props);
      }, []);
      captureAuthModalProps(props);
      return null;
    },
  };
});

const captureProfileModalProps = vi.hoisted(() => vi.fn());
vi.mock("../oauth/OAuthProfileModal", () => ({
  OAuthProfileModal: (props: unknown) => {
    captureProfileModalProps(props);
    return null;
  },
}));

const captureLoggerProps = vi.hoisted(() => vi.fn());
vi.mock("../oauth/OAuthFlowLogger", () => ({
  OAuthFlowLogger: (props: unknown) => {
    captureLoggerProps(props);
    return <div data-testid="oauth-flow-logger" />;
  },
}));

type LoggerActions = {
  onContinue?: () => Promise<void>;
  continueLabel?: string;
};
const latestLoggerActions = (): LoggerActions =>
  (captureLoggerProps.mock.lastCall?.[0] as { actions: LoggerActions })
    .actions;
vi.mock("../oauth/RefreshTokensConfirmModal", () => ({
  RefreshTokensConfirmModal: () => null,
}));
vi.mock("../ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div />,
}));

import { OAuthFlowTab } from "@/components/OAuthFlowTab";

const httpServer = (name: string, protocolVersion = "2025-11-25") =>
  ({
    name,
    connectionStatus: "disconnected",
    enabled: true,
    retryCount: 0,
    useOAuth: true,
    lastConnectionTime: new Date("2024-01-01"),
    config: { url: "https://mcp.example.com/mcp" },
    oauthFlowProfile: {
      serverUrl: "https://mcp.example.com/mcp",
      clientId: "",
      clientSecret: "",
      scopes: "",
      customHeaders: [],
      protocolVersion,
      registrationStrategy: "dcr",
    } as ServerWithName["oauthFlowProfile"],
  }) as ServerWithName;

let commandSeq = 0;
async function dispatch(command: Omit<InspectorCommand, "id">) {
  commandSeq += 1;
  let response!: InspectorCommandResponse;
  await act(async () => {
    response = await executeInspectorCommand({
      ...command,
      id: `oauth-bridge-${commandSeq}`,
    } as InspectorCommand);
  });
  return response;
}

function renderTab(overrides?: {
  serverConfigs?: Record<string, ServerWithName>;
  selectedServerName?: string;
}) {
  const serverConfigs = overrides?.serverConfigs ?? {
    linear: httpServer("linear"),
    other: httpServer("other"),
  };
  return render(
    <OAuthFlowTab
      serverConfigs={serverConfigs}
      selectedServerName={overrides?.selectedServerName ?? "linear"}
      hasHeaderServers
      areServersHydrated
      onSelectServer={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  machineCtl.onAdvance = null;
  machineCtl.updateState = null;
});

describe("OAuthFlowTab — advanceOauthFlow", () => {
  it("rejects when no target is configured (invalid_request, machine untouched)", async () => {
    renderTab({ serverConfigs: {}, selectedServerName: "none" });
    const response = await dispatch({ type: "advanceOauthFlow", payload: {} });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "invalid_request" },
    });
  });

  it("advances one step and reports the post-step state from the synced ref", async () => {
    renderTab();
    machineCtl.onAdvance = (update) =>
      update({
        currentStep: "request_without_token",
        lastResponse: {
          status: 401,
          statusText: "Unauthorized",
          headers: {},
          body: {},
        },
      });
    const response = await dispatch({ type: "advanceOauthFlow", payload: {} });
    expect(response).toMatchObject({
      status: "success",
      result: {
        status: "advanced",
        previousStep: "idle",
        currentStep: "request_without_token",
        ok: true,
        httpStatus: 401,
      },
    });
  });

  it("reduces a step error to an allowlisted code, never the raw text", async () => {
    renderTab();
    machineCtl.onAdvance = (update) =>
      update({
        currentStep: "request_without_token",
        error: "AS exploded: token=SENTINEL_LEAK invalid_client",
      });
    const response = await dispatch({ type: "advanceOauthFlow", payload: {} });
    expect(response.status).toBe("success");
    const result = (response as { result: Record<string, unknown> }).result;
    expect(result).toMatchObject({ ok: false, oauthErrorCode: "invalid_client" });
    expect(JSON.stringify(result)).not.toContain("SENTINEL_LEAK");
  });

  it("at the PKCE step: advances first, then opens the human auth modal without passing authorization", async () => {
    renderTab();
    // Step 1: land on generate_pkce_parameters.
    machineCtl.onAdvance = (update) =>
      update({ currentStep: "generate_pkce_parameters" });
    await dispatch({ type: "advanceOauthFlow", payload: {} });

    // Step 2: the PKCE advance produces the authorization URL; the handler
    // must then hand off to the human, not keep advancing.
    let advances = 0;
    machineCtl.onAdvance = (update) => {
      advances += 1;
      update({
        currentStep: "authorization_request",
        authorizationUrl: "https://auth.example.com/authorize?x=1",
      });
    };
    const response = await dispatch({ type: "advanceOauthFlow", payload: {} });
    expect(response).toMatchObject({
      status: "success",
      result: {
        status: "authorization_modal_opened",
        currentStep: "authorization_request",
      },
    });
    expect(advances).toBe(1);
    await waitFor(() => {
      expect(captureAuthModalProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ open: true }),
      );
    });
  });

  it("rejects while a step is in flight (execution_failed) and after completion (invalid_request)", async () => {
    renderTab();
    machineCtl.onAdvance = (update) => update({ isInitiatingAuth: true });
    await dispatch({ type: "advanceOauthFlow", payload: {} });
    const busy = await dispatch({ type: "advanceOauthFlow", payload: {} });
    expect(busy).toMatchObject({
      status: "error",
      error: { code: "execution_failed" },
    });

    machineCtl.updateState?.({ isInitiatingAuth: false, currentStep: "complete" });
    const done = await dispatch({ type: "advanceOauthFlow", payload: {} });
    expect(done).toMatchObject({
      status: "error",
      error: { code: "invalid_request" },
    });
  });
});

// The AS rejected the exchange (expired/used code): the SDK machine clears the
// spent code and stays on token_request with the rejection as the error.
const REJECTED_EXCHANGE: Partial<OAuthFlowState> = {
  currentStep: "token_request",
  authorizationUrl: "https://auth.example.com/authorize?x=1",
  authorizationCode: undefined,
  error: "Token request failed: 400 Bad Request: invalid_grant: Grant code expired",
  lastResponse: {
    status: 400,
    statusText: "Bad Request",
    headers: {},
    body: { error: "invalid_grant" },
  },
  // The PKCE and URL steps log under fixed ids; a rewind must drop those two.
  infoLogs: [
    { id: "client-registration", level: "info" },
    { id: "pkce-generation", level: "info" },
    { id: "auth-url", level: "info" },
  ] as OAuthFlowState["infoLogs"],
};

const FRESH_AUTHORIZATION_URL = "https://auth.example.com/authorize?x=2";

describe("OAuthFlowTab, after the AS rejects the authorization code", () => {
  // Scripts the machine's two regeneration steps and records the step each
  // advance started from, so tests can pin that recovery restarts BEFORE PKCE
  // generation rather than reusing the spent verifier, state and URL.
  async function renderAtRejectedExchange(
    regeneration: Partial<OAuthFlowState>[] = [
      { currentStep: "generate_pkce_parameters", state: "fresh-state" },
      {
        currentStep: "authorization_request",
        authorizationUrl: FRESH_AUTHORIZATION_URL,
      },
    ],
  ) {
    renderTab();
    machineCtl.onAdvance = (update) => update(REJECTED_EXCHANGE);
    await dispatch({ type: "advanceOauthFlow", payload: {} });
    const startedFrom: Array<{ step: string; url?: string }> = [];
    const rewoundTo: OAuthFlowState[] = [];
    machineCtl.onAdvance = (update, getState) => {
      if (startedFrom.length === 0) rewoundTo.push(getState());
      startedFrom.push({
        step: getState().currentStep,
        url: getState().authorizationUrl,
      });
      const next = regeneration[startedFrom.length - 1];
      if (next) update(next);
    };
    return { startedFrom, rewoundState: () => rewoundTo[0] };
  }

  it("rewinds with the spent transaction's logs and HTTP response dropped", async () => {
    const { rewoundState } = await renderAtRejectedExchange();

    await act(async () => {
      await latestLoggerActions().onContinue?.();
    });

    expect((rewoundState().infoLogs ?? []).map((log) => log.id)).toEqual([
      "client-registration",
    ]);
    expect(rewoundState().lastResponse).toBeUndefined();
  });

  it("reports the rejected-code step to agents as awaiting human sign-in", async () => {
    await renderAtRejectedExchange();
    const snapshot = JSON.stringify(await readSurfaceSnapshot("oauth-flow"));
    expect(snapshot).toContain('"currentStep":"token_request"');
    expect(snapshot).toContain('"awaitingHumanAuthorization":true');
  });

  it("remounts the auth modal so the popup reopens even if it never closed", async () => {
    // Electron fallback: the callback arrives by IPC, which the modal does not
    // hear, so it can still be open when the token exchange is rejected.
    renderTab();
    machineCtl.onAdvance = (update) =>
      update({ currentStep: "generate_pkce_parameters" });
    await dispatch({ type: "advanceOauthFlow", payload: {} });
    machineCtl.onAdvance = (update) =>
      update({
        currentStep: "authorization_request",
        authorizationUrl: "https://auth.example.com/authorize?x=1",
      });
    await dispatch({ type: "advanceOauthFlow", payload: {} });
    await act(async () => {
      machineCtl.updateState?.(REJECTED_EXCHANGE);
    });
    expect(captureAuthModalProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true }),
    );
    const mountsBefore = captureAuthModalMount.mock.calls.length;

    const regeneration: Partial<OAuthFlowState>[] = [
      { currentStep: "generate_pkce_parameters" },
      {
        currentStep: "authorization_request",
        authorizationUrl: FRESH_AUTHORIZATION_URL,
      },
    ];
    let step = 0;
    machineCtl.onAdvance = (update) => update(regeneration[step++] ?? {});
    await act(async () => {
      await latestLoggerActions().onContinue?.();
    });

    expect(captureAuthModalMount.mock.calls.length).toBe(mountsBefore + 1);
    expect(captureAuthModalMount).toHaveBeenLastCalledWith(
      expect.objectContaining({
        open: true,
        authorizationUrl: FRESH_AUTHORIZATION_URL,
      }),
    );
  });

  it("does not blame a regeneration failure on the earlier token rejection", async () => {
    await renderAtRejectedExchange([
      { error: "Missing authorization endpoint or client ID" },
    ]);
    const response = await dispatch({ type: "advanceOauthFlow", payload: {} });
    expect(response.status).toBe("success");
    const result = (response as { result: Record<string, unknown> }).result;
    expect(result).toMatchObject({ status: "advanced", ok: false });
    expect(result).not.toHaveProperty("httpStatus");
    expect(result).not.toHaveProperty("oauthErrorCode");
  });

  it("Continue reads Authorize and reopens the popup with a freshly generated URL", async () => {
    const { startedFrom } = await renderAtRejectedExchange();
    expect(latestLoggerActions().continueLabel).toBe("Authorize");

    await act(async () => {
      await latestLoggerActions().onContinue?.();
    });

    expect(startedFrom).toEqual([
      { step: "received_client_credentials", url: undefined },
      { step: "generate_pkce_parameters", url: undefined },
    ]);
    await waitFor(() => {
      expect(captureAuthModalProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          open: true,
          authorizationUrl: FRESH_AUTHORIZATION_URL,
        }),
      );
    });
  });

  it("the agent advance regenerates too and hands off to the human popup", async () => {
    const { startedFrom } = await renderAtRejectedExchange();
    const response = await dispatch({ type: "advanceOauthFlow", payload: {} });
    expect(response).toMatchObject({
      status: "success",
      result: {
        status: "authorization_modal_opened",
        currentStep: "authorization_request",
      },
    });
    expect(startedFrom.map((entry) => entry.step)).toEqual([
      "received_client_credentials",
      "generate_pkce_parameters",
    ]);
  });

  it("keeps the popup closed when regenerating the request fails", async () => {
    const { startedFrom } = await renderAtRejectedExchange([
      { error: "Missing authorization endpoint or client ID" },
    ]);

    await act(async () => {
      await latestLoggerActions().onContinue?.();
    });

    expect(startedFrom).toHaveLength(1);
    expect(captureAuthModalProps).not.toHaveBeenCalledWith(
      expect.objectContaining({ open: true }),
    );
  });

  it("a token_request that still holds a code advances normally", async () => {
    renderTab();
    machineCtl.onAdvance = (update) =>
      update({ currentStep: "token_request", authorizationCode: "fresh-code" });
    await dispatch({ type: "advanceOauthFlow", payload: {} });
    let advances = 0;
    machineCtl.onAdvance = () => {
      advances += 1;
    };
    expect(latestLoggerActions().continueLabel).toBe("Continue");

    await act(async () => {
      await latestLoggerActions().onContinue?.();
    });

    expect(advances).toBe(1);
  });
});

describe("OAuthFlowTab — resetOauthFlow", () => {
  it("resets the flow back to idle", async () => {
    renderTab();
    machineCtl.onAdvance = (update) =>
      update({ currentStep: "token_request", accessToken: "SENTINEL_TOKEN" });
    await dispatch({ type: "advanceOauthFlow", payload: {} });

    const response = await dispatch({ type: "resetOauthFlow", payload: {} });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "reset", currentStep: "idle" },
    });
    const snapshot = await readSurfaceSnapshot("oauth-flow");
    expect(JSON.stringify(snapshot)).toContain('"currentStep":"idle"');
  });
});

describe("OAuthFlowTab — openOauthServerConfig", () => {
  it("opens the modal in edit mode with the agent seed for the selected server", async () => {
    renderTab();
    const response = await dispatch({
      type: "openOauthServerConfig",
      payload: { serverUrl: "https://new.example.com/mcp", registrationMode: "dcr" },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "form_opened", mode: "edit" },
    });
    await waitFor(() => {
      expect(captureProfileModalProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          open: true,
          agentSeed: {
            serverUrl: "https://new.example.com/mcp",
            registrationStrategy: "dcr",
          },
        }),
      );
    });
  });

  it("opens add mode for a new name and rejects a different existing server's name", async () => {
    renderTab();
    const added = await dispatch({
      type: "openOauthServerConfig",
      payload: { serverName: "brand-new" },
    });
    expect(added).toMatchObject({
      status: "success",
      result: { status: "form_opened", mode: "add" },
    });

    const collision = await dispatch({
      type: "openOauthServerConfig",
      payload: { serverName: "other" },
    });
    expect(collision).toMatchObject({
      status: "error",
      error: { code: "invalid_request" },
    });
    expect(
      (collision as { error: { message: string } }).error.message,
    ).toContain("ui_select_server");
  });

  it("rejects a registration mode the target's protocol version does not support", async () => {
    renderTab({
      serverConfigs: { legacy: httpServer("legacy", "2025-03-26") },
      selectedServerName: "legacy",
    });
    const response = await dispatch({
      type: "openOauthServerConfig",
      payload: { registrationMode: "cimd" },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "invalid_request" },
    });
    expect((response as { error: { message: string } }).error.message).toContain(
      "2025-03-26",
    );
  });
});

describe("OAuthFlowTab — surface snapshot", () => {
  it("never leaks token material and strips sequence steps to id/label", async () => {
    renderTab();
    machineCtl.onAdvance = (update) =>
      update({
        currentStep: "token_request",
        accessToken: "SENTINEL_ACCESS_TOKEN",
        refreshToken: "SENTINEL_REFRESH_TOKEN",
        codeVerifier: "SENTINEL_VERIFIER",
        authorizationCode: "SENTINEL_AUTH_CODE",
        state: "SENTINEL_CSRF",
        error: "boom SENTINEL_RAW_ERROR invalid_grant",
        lastResponse: {
          status: 400,
          statusText: "Bad Request",
          headers: { "set-cookie": "SENTINEL_COOKIE" },
          body: { access_token: "SENTINEL_ACCESS_TOKEN" },
        },
      });
    await dispatch({ type: "advanceOauthFlow", payload: {} });

    const snapshot = await readSurfaceSnapshot("oauth-flow");
    const serialized = JSON.stringify(snapshot);
    for (const sentinel of [
      "SENTINEL_ACCESS_TOKEN",
      "SENTINEL_REFRESH_TOKEN",
      "SENTINEL_VERIFIER",
      "SENTINEL_AUTH_CODE",
      "SENTINEL_CSRF",
      "SENTINEL_RAW_ERROR",
      "SENTINEL_COOKIE",
      "SENTINEL_DIAGRAM_DETAIL",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(serialized).toContain('"hasAccessToken":true');
    expect(serialized).toContain('"oauthErrorCode":"invalid_grant"');
    expect(serialized).toContain(
      '"steps":[{"id":"request_without_token","label":"MCP request without token"}]',
    );
  });
});
