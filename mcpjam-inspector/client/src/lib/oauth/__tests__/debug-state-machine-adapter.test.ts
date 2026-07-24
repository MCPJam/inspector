import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_OAUTH_FLOW_STATE,
  type OAuthFlowState,
} from "@mcpjam/sdk/browser";
import {
  createInspectorOAuthStateMachine,
  type InspectorOAuthStateMachineConfig,
} from "../debug-state-machine-adapter";

const createOAuthStateMachineSpy = vi.fn(() => ({
  proceedToNextStep: vi.fn(),
  startGuidedFlow: vi.fn(),
  resetFlow: vi.fn(),
}));

vi.mock("@mcpjam/sdk/browser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk/browser")>();
  return {
    ...actual,
    createOAuthStateMachine: (config: unknown) =>
      createOAuthStateMachineSpy(config as never),
  };
});

const tryResolveProjectServer = vi.fn();
vi.mock("@/lib/apis/web/context", () => ({
  tryResolveProjectServer: (name: string) => tryResolveProjectServer(name),
}));

const fetchOAuthClientSecret = vi.fn();
vi.mock("@/lib/apis/hosted-oauth-client-secret-api", () => ({
  fetchOAuthClientSecret: (req: unknown) => fetchOAuthClientSecret(req),
}));

vi.mock("@/lib/config", () => ({ HOSTED_MODE: false }));
vi.mock("@/lib/session-token", () => ({ authFetch: vi.fn() }));

const SERVER_NAME = "Test Server";

type LoaderInput = { serverName: string; serverUrl: string };
type CapturedConfig = {
  hasClientSecret?: boolean;
  loadPreregisteredCredentials: (
    input: LoaderInput,
  ) => Promise<{ clientId?: string; clientSecret?: string }>;
};

function buildMachineConfig(
  overrides: Partial<InspectorOAuthStateMachineConfig>,
): CapturedConfig {
  createOAuthStateMachineSpy.mockClear();
  const state: OAuthFlowState = { ...EMPTY_OAUTH_FLOW_STATE };
  createInspectorOAuthStateMachine({
    protocolVersion: "2025-11-25",
    registrationStrategy: "preregistered",
    state,
    getState: () => state,
    updateState: vi.fn(),
    serverUrl: "https://mcp.example.com",
    serverName: SERVER_NAME,
    ...overrides,
  });
  return createOAuthStateMachineSpy.mock.calls[0][0] as CapturedConfig;
}

const loaderInput: LoaderInput = {
  serverName: SERVER_NAME,
  serverUrl: "https://mcp.example.com",
};

describe("Inspector OAuth adapter pre-registered client secret", () => {
  beforeEach(() => {
    localStorage.clear();
    tryResolveProjectServer.mockReset();
    fetchOAuthClientSecret.mockReset();
    localStorage.setItem(
      `mcp-client-${SERVER_NAME}`,
      JSON.stringify({ client_id: "client_abc" }),
    );
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("fetches the Convex-backed secret and marks the client confidential", async () => {
    tryResolveProjectServer.mockReturnValue({
      projectId: "proj_1",
      serverId: "srv_1",
    });
    fetchOAuthClientSecret.mockResolvedValue({ clientSecret: "shhh" });

    const config = buildMachineConfig({ hasClientSecret: true });

    expect(config.hasClientSecret).toBe(true);
    const creds = await config.loadPreregisteredCredentials(loaderInput);
    expect(creds).toEqual({ clientId: "client_abc", clientSecret: "shhh" });
    expect(fetchOAuthClientSecret).toHaveBeenCalledWith({
      projectId: "proj_1",
      serverId: "srv_1",
    });
  });

  it("uses an explicit profile secret without fetching from Convex", async () => {
    const config = buildMachineConfig({
      preregisteredClientId: "client_from_profile",
      preregisteredClientSecret: "  explicit-secret  ",
    });

    expect(config.hasClientSecret).toBe(true);
    const creds = await config.loadPreregisteredCredentials(loaderInput);
    expect(creds.clientId).toBe("client_from_profile");
    expect(creds.clientSecret).toBe("explicit-secret");
    expect(fetchOAuthClientSecret).not.toHaveBeenCalled();
    expect(tryResolveProjectServer).not.toHaveBeenCalled();
  });

  it("pairs a profile clientId with the Convex-backed secret", async () => {
    tryResolveProjectServer.mockReturnValue({
      projectId: "proj_1",
      serverId: "srv_1",
    });
    fetchOAuthClientSecret.mockResolvedValue({ clientSecret: "shhh" });

    const config = buildMachineConfig({
      preregisteredClientId: "client_from_profile",
      hasClientSecret: true,
    });

    const creds = await config.loadPreregisteredCredentials(loaderInput);
    // The profile clientId is authoritative over the stored record, and the
    // synced secret still applies — it belongs to the server, not the record.
    expect(creds).toEqual({
      clientId: "client_from_profile",
      clientSecret: "shhh",
    });
  });

  it("degrades to no secret when the server has no Convex mapping", async () => {
    tryResolveProjectServer.mockReturnValue(null);

    const config = buildMachineConfig({ hasClientSecret: true });
    const creds = await config.loadPreregisteredCredentials(loaderInput);

    expect(creds.clientSecret).toBeUndefined();
    expect(creds.clientId).toBe("client_abc");
    expect(fetchOAuthClientSecret).not.toHaveBeenCalled();
  });

  it("degrades to no secret when the secret fetch fails", async () => {
    tryResolveProjectServer.mockReturnValue({
      projectId: "proj_1",
      serverId: "srv_1",
    });
    fetchOAuthClientSecret.mockRejectedValue(new Error("boom"));

    const config = buildMachineConfig({ hasClientSecret: true });
    const creds = await config.loadPreregisteredCredentials(loaderInput);

    expect(creds.clientSecret).toBeUndefined();
  });

  it("memoizes a successful fetch across loader invocations", async () => {
    tryResolveProjectServer.mockReturnValue({
      projectId: "proj_1",
      serverId: "srv_1",
    });
    fetchOAuthClientSecret.mockResolvedValue({ clientSecret: "shhh" });

    const config = buildMachineConfig({ hasClientSecret: true });
    await config.loadPreregisteredCredentials(loaderInput);
    await config.loadPreregisteredCredentials(loaderInput);

    expect(fetchOAuthClientSecret).toHaveBeenCalledTimes(1);
  });

  it("does not mark the client confidential when no secret is configured", async () => {
    const config = buildMachineConfig({});

    expect(config.hasClientSecret).toBe(false);
    const creds = await config.loadPreregisteredCredentials(loaderInput);
    expect(creds.clientSecret).toBeUndefined();
    expect(fetchOAuthClientSecret).not.toHaveBeenCalled();
  });

  it("scrubs any legacy client_secret persisted in localStorage", async () => {
    localStorage.setItem(
      `mcp-client-${SERVER_NAME}`,
      JSON.stringify({ client_id: "client_abc", client_secret: "leaked" }),
    );

    const config = buildMachineConfig({ hasClientSecret: false });
    await config.loadPreregisteredCredentials(loaderInput);

    const stored = JSON.parse(
      localStorage.getItem(`mcp-client-${SERVER_NAME}`) ?? "{}",
    );
    expect(stored).not.toHaveProperty("client_secret");
    expect(stored.client_id).toBe("client_abc");
  });
});

describe("Inspector OAuth adapter one-step stepping", () => {
  it("omits scheduleAutoAdvance so each Continue advances exactly one step", () => {
    const config = buildMachineConfig({}) as unknown as Record<string, unknown>;
    // Absent, not merely undefined: the SDK debug machines call
    // scheduleAutoAdvance via optional chaining, so leaving it out is precisely
    // what stops the prepare -> send -> receive burst on a single click.
    expect("scheduleAutoAdvance" in config).toBe(false);
  });
});

describe("Inspector OAuth adapter SSRF loopback opt-in", () => {
  // The SSRF guard blocks loopback metadata fetches unless the machine opts in.
  // The debugger is a local-dev surface, so it must opt in whenever the server
  // under test is itself loopback (e.g. a 127.0.0.1 dev MCP server) — otherwise
  // discovery is refused and the flow never reaches "Authorize" (regression the
  // oauth-debugger e2e caught).
  it("allows loopback metadata fetch for a 127.0.0.1 server under test", () => {
    const config = buildMachineConfig({
      serverUrl: "http://127.0.0.1:52144/mcp",
    }) as unknown as Record<string, unknown>;
    expect(config.allowLoopbackMetadataFetch).toBe(true);
  });

  it("does not allow loopback for a public server under test", () => {
    const config = buildMachineConfig({
      serverUrl: "https://mcp.example.com/mcp",
    }) as unknown as Record<string, unknown>;
    expect(config.allowLoopbackMetadataFetch).toBe(false);
  });
});
