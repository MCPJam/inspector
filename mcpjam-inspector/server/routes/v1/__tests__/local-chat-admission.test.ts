import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const { query, mutation, preflight } = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  preflight: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query = query;
    mutation = mutation;
  },
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "verified-jwt",
}));
vi.mock(
  "../../../services/environments/runtime.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/environments/runtime.js")
    >()),
    resolveEnvironmentForRuntime: async () => ({
      host: { hostId: "host", runtimeConfig: { harness: "codex" } },
      servers: { effectiveServerIds: ["server"] },
    }),
  }),
);
vi.mock("../../../services/environments/plugin-attribution.js", () => ({
  fetchPluginRuntimeAttribution: async () => null,
}));
vi.mock("../../../services/environments/effective-capabilities.js", () => ({
  resolveEffectiveCapabilities: () => undefined,
  buildLiveEffectiveCapabilities: () => undefined,
}));
vi.mock("../local-execution-preflight.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../local-execution-preflight.js")>()),
  preflightLocalExecution: preflight,
}));
import chatSessions from "../chat-sessions";
import { v1OnError } from "../envelope";
import { WebRouteError, ErrorCode } from "../../web/errors";
const target = {
  kind: "local-native",
  scope: "unattended",
  harnessId: "codex",
  machineId: "machine",
  workspaceGrantId: "workspace",
  runtimeId: "runtime",
  permissionProfile: "unrestricted",
  policyVersion: "policy",
};
const app = new Hono();
app.onError(v1OnError);
app.route("/", chatSessions);
const post = (body: object) =>
  app.request("/chat-sessions/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mcpjam-local-harness-grant": "capability",
    },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://test.convex.cloud");
  vi.stubEnv("CONVEX_HTTP_URL", "https://test.convex.site");
});
describe("local chat admission precedes allocation", () => {
  it.each(["expired grant", "wrong machine", "runtime unavailable"])(
    "refuses %s before a turn lease",
    async (message) => {
      preflight.mockRejectedValue(
        new WebRouteError(409, ErrorCode.CONFLICT, message),
      );
      const response = await post({
        projectId: "project",
        idempotencyKey: "intent",
        modelId: "openai/gpt-5.5",
        environmentId: "environment",
        message: "hello",
        toolMode: "auto",
        executionTarget: target,
      });
      expect(response.status).toBe(409);
      expect(preflight).toHaveBeenCalledWith(
        expect.objectContaining({
          grantToken: "capability",
          projectId: "project",
          target,
        }),
      );
      expect(mutation).not.toHaveBeenCalled();
    },
  );
  it("passes per-turn browser requirements to preflight before a lease", async () => {
    preflight.mockRejectedValue(
      new WebRouteError(
        422,
        ErrorCode.FEATURE_NOT_SUPPORTED,
        "Unsupported browser",
      ),
    );
    const response = await post({
      projectId: "project",
      idempotencyKey: "browser-intent",
      modelId: "openai/gpt-5.5",
      environmentId: "environment",
      message: "browse",
      toolMode: "auto",
      executionTarget: target,
      browser: {},
    });
    expect(response.status).toBe(422);
    expect(preflight).toHaveBeenCalledWith(
      expect.objectContaining({ requestedBrowser: {} }),
    );
    expect(mutation).not.toHaveBeenCalled();
  });
  it("does not silently move a local continuation to hosted", async () => {
    query.mockResolvedValue({
      _id: "session",
      chatSessionId: "wire",
      projectId: "project",
      origin: "api",
      sourceType: "direct",
      version: 1,
      resumeConfig: {
        modelId: "openai/gpt-5.5",
        toolMode: "auto",
        environmentId: "environment",
        executionVenue: "local",
      },
    });
    const response = await post({
      sessionId: "session",
      idempotencyKey: "next",
      message: "continue",
    });
    expect(response.status).toBe(400);
    expect(mutation).not.toHaveBeenCalled();
  });
});
