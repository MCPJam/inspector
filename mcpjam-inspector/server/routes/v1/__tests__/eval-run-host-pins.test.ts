/**
 * A v1 eval run connects AS the host it executes under.
 *
 * This path had no host-persona input at all: it passed `undefined` for client
 * capabilities and sent no initialize pins, so a suite pinned to a protocol
 * version, a client identity, or first-page-only pagination ran as a default
 * client that matched nothing the settings page claimed. There is no browser
 * here to send pins, so everything must come from the host — which the route
 * already loads for its harness gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  validateGuestTokenMock,
  prepareEvalRunMock,
  createAuthorizedManagerMock,
  loadSuiteHostConfigMock,
  convexQueryMock,
  convexMutationMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  prepareEvalRunMock: vi.fn(),
  createAuthorizedManagerMock: vi.fn(),
  loadSuiteHostConfigMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../shared/evals.js", async () => {
  const actual = await vi.importActual<typeof import("../../shared/evals.js")>(
    "../../shared/evals.js",
  );
  return { ...actual, prepareEvalRun: prepareEvalRunMock };
});

vi.mock("../../web/auth.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../web/auth.js")>(
      "../../web/auth.js",
    );
  return { ...actual, createAuthorizedManager: createAuthorizedManagerMock };
});

vi.mock("../../../services/evals/compat-runtime.js", () => ({
  loadSuiteHostConfig: loadSuiteHostConfigMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: convexMutationMock,
    action: vi.fn(),
  })),
}));

import v1Routes from "../index.js";

const PROJECT_ID = "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUITE_ID = "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx";

/** A host that pins one of everything the connection can carry. */
const PINNED_HOST = {
  clientCapabilities: { roots: {}, sampling: {} },
  connectionDefaults: { requestTimeout: 12_000 },
  mcpProfile: {
    profileVersion: 1,
    mcpProtocolVersion: "2026-07-28",
    initialize: {
      clientInfo: { name: "Claude Code", version: "2.0.0" },
      supportedProtocolVersions: ["2026-07-28"],
    },
    paginationTraversal: "firstPageOnly",
    mrtrSupport: "none",
  },
  serverConnectionOverrides: {
    "srv-1": {
      mcpProtocolVersionOverride: "2025-11-25",
      requestTimeoutOverride: 4_000,
    },
  },
};

function request(body: Record<string, unknown>): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(`/api/v1/projects/${PROJECT_ID}/eval-runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
      },
      body: JSON.stringify(body),
    }),
  );
}

function managerOptions() {
  return createAuthorizedManagerMock.mock.calls[0] ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONVEX_URL = "https://convex.example.com";
  process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
  validateGuestTokenMock.mockResolvedValue({ valid: false });
  convexQueryMock.mockImplementation(async (fn: string) => {
    if (fn === "testSuites:getTestSuite") {
      return { _id: SUITE_ID, projectId: PROJECT_ID, name: "Smoke" };
    }
    return {};
  });
  loadSuiteHostConfigMock.mockResolvedValue(PINNED_HOST);
  createAuthorizedManagerMock.mockResolvedValue({
    manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    oauthServerUrls: {},
    authenticatedUserId: null,
  });
  prepareEvalRunMock.mockResolvedValue({
    suiteId: SUITE_ID,
    runId: "run1xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    caseUpsert: { committed: [], failed: [] },
    recorder: { finalize: vi.fn() },
    execute: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  delete process.env.CONVEX_URL;
  delete process.env.CONVEX_HTTP_URL;
});

describe("v1 eval run — connects as the run's host", () => {
  it.each([true, false])(
    "projects only the durable client fields when present: %s",
    async (hasClient) => {
      const client = {
        namedHostId: "host-1",
        name: "Frozen client",
        hostStyle: "claude",
        modelId: "haiku",
        source: "attached_host",
        backfilled: true,
        hostConfigId: "private-config",
      };
      convexQueryMock.mockImplementation(async (fn: string) =>
        fn === "testSuites:getTestSuiteRun"
          ? {
              _id: "run1xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
              suiteId: SUITE_ID,
              projectId: PROJECT_ID,
              status: "completed",
              modelSource: "case",
              ...(hasClient ? { client } : {}),
            }
          : null,
      );
      const app = new Hono();
      app.route("/api/v1", v1Routes);
      const response = await app.request(
        `/api/v1/projects/${PROJECT_ID}/eval-runs/run1xxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
        { headers: { Authorization: "Bearer tok" } },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.modelSource).toBe("case");
      if (hasClient)
        expect(body.client).toEqual({
          id: "host-1",
          name: "Frozen client",
          hostStyle: "claude",
          modelId: "haiku",
          source: "attached_host",
        });
      else expect(body).not.toHaveProperty("client");
    },
  );
  it("resolves inline hosts before authoring and launches with their config", async () => {
    convexQueryMock.mockResolvedValue([{ hostId: "host-1", name: "Claude" }]);
    const response = await request({
      suiteName: "Inline",
      serverIds: ["srv-1"],
      serverNames: ["alpha"],
      hosts: [{ host: "Claude", servers: ["alpha"] }],
      tests: [
        {
          title: "Smoke",
          steps: [{ id: "s1", kind: "prompt", prompt: "Hello" }],
          model: "openai/gpt-4o",
          provider: "openai",
          runs: 1,
        },
      ],
    });
    expect(response.status, await response.clone().text()).toBe(202);
    expect(prepareEvalRunMock.mock.calls[0][1]).toMatchObject({
      namedHostId: "host-1",
      hostAttachments: [
        { namedHostId: "host-1", selectedServerIds: ["srv-1"] },
      ],
    });
    expect(loadSuiteHostConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      "host-1",
    );
  });

  it("rejects inline attachments on existing suites before authoring", async () => {
    const response = await request({
      suiteId: SUITE_ID,
      hosts: [{ host: "Claude" }],
    });
    expect(response.status).toBe(400);
    expect(prepareEvalRunMock).not.toHaveBeenCalled();
  });

  it("rejects unknown inline hosts before authoring or connecting", async () => {
    convexQueryMock.mockResolvedValue([]);
    const response = await request({
      suiteName: "Inline",
      serverIds: ["srv-1"],
      hosts: [{ host: "Missing" }],
      tests: [
        {
          title: "Smoke",
          steps: [{ id: "s1", kind: "prompt", prompt: "Hello" }],
          model: "openai/gpt-4o",
          provider: "openai",
          runs: 1,
        },
      ],
    });
    expect(response.status, await response.clone().text()).toBe(404);
    expect(prepareEvalRunMock).not.toHaveBeenCalled();
    expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
  });
  it("sends the host's initialize pins, capabilities and timeouts", async () => {
    const response = await request({ suiteId: SUITE_ID, serverIds: ["srv-1"] });
    expect(response.status).toBeLessThan(400);

    const [, , , , timeoutMs, , clientCapabilities, options] = managerOptions();

    // The host's own request timeout, not the route's 30s default.
    expect(timeoutMs).toBe(12_000);
    // Previously `undefined` — the run advertised whatever the SDK defaults to.
    expect(clientCapabilities).toEqual({ roots: {}, sampling: {} });
    expect(options.initializePins).toEqual(
      expect.objectContaining({
        clientInfo: { name: "Claude Code", version: "2.0.0" },
        supportedProtocolVersions: ["2026-07-28"],
        mcpProtocolVersion: "2026-07-28",
      }),
    );
    // A per-server pin beats the host's batch-level one, per server.
    expect(options.mcpProtocolVersionsByServerId).toEqual({
      "srv-1": "2025-11-25",
    });
    expect(options.requestTimeoutByServerId).toEqual({ "srv-1": 4_000 });
  });

  it("applies the host's conformance knobs", async () => {
    await request({ suiteId: SUITE_ID, serverIds: ["srv-1"] });
    const [, , , , , , , options] = managerOptions();
    // Suppression switches: only the non-default value travels.
    expect(options.initializePins.firstPageOnly).toBe(true);
    expect(options.initializePins.supportsMrtr).toBe(false);
    expect(options.initializePins.suppressListenChannel).toBeUndefined();
  });

  it("reads the enterprise policy from the run's host", async () => {
    loadSuiteHostConfigMock.mockResolvedValue({
      ...PINNED_HOST,
      mcpProfile: {
        ...PINNED_HOST.mcpProfile,
        xaa: { enterpriseManagedAuthorization: "on" },
      },
    });
    await request({ suiteId: SUITE_ID, serverIds: ["srv-1"] });
    const [, , , , , , , options] = managerOptions();
    expect(options).toHaveProperty("xaaPolicy");
  });

  it("stays on the plain defaults for a host that pins nothing", async () => {
    // A suite with no attachment resolves to the default MCPJam host, which
    // pins nothing — the run must look exactly as it did before this change
    // rather than gaining an empty pin object.
    loadSuiteHostConfigMock.mockResolvedValue({});
    await request({ suiteId: SUITE_ID, serverIds: ["srv-1"] });
    const [, , , , timeoutMs, , clientCapabilities, options] = managerOptions();
    expect(timeoutMs).toBe(30_000);
    expect(clientCapabilities).toBeUndefined();
    expect(options.initializePins).toBeUndefined();
    expect(options.mcpProtocolVersionsByServerId).toBeUndefined();
    expect(options.requestTimeoutByServerId).toBeUndefined();
  });
});
