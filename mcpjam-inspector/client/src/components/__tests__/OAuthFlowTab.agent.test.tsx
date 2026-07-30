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
    | ((update: (u: Partial<OAuthFlowState>) => void) => void)
    | null,
  updateState: null as ((u: Partial<OAuthFlowState>) => void) | null,
}));

vi.mock("@/lib/oauth/debug-state-machine-adapter", () => ({
  createInspectorOAuthStateMachine: (opts: {
    updateState: (u: Partial<OAuthFlowState>) => void;
  }) => {
    machineCtl.updateState = opts.updateState;
    return {
      proceedToNextStep: async () => {
        machineCtl.onAdvance?.(opts.updateState);
      },
    };
  },
}));

vi.mock("@/components/oauth/OAuthSequenceDiagram", () => ({
  OAuthSequenceDiagram: () => <div data-testid="oauth-sequence-diagram" />,
}));

const captureAuthModalProps = vi.hoisted(() => vi.fn());
vi.mock("@/components/oauth/OAuthAuthorizationModal", () => ({
  OAuthAuthorizationModal: (props: unknown) => {
    captureAuthModalProps(props);
    return null;
  },
}));

const captureProfileModalProps = vi.hoisted(() => vi.fn());
vi.mock("../oauth/OAuthProfileModal", () => ({
  OAuthProfileModal: (props: unknown) => {
    captureProfileModalProps(props);
    return null;
  },
}));

vi.mock("../oauth/OAuthFlowLogger", () => ({
  OAuthFlowLogger: () => <div data-testid="oauth-flow-logger" />,
}));
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
