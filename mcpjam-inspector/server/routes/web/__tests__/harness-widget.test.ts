import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { harnessWidgets } from "../harness-widget.js";
import { ExecutionControlError } from "../../../utils/harness/forwarding/execution-control.js";

const state = vi.hoisted(() => ({
  userId: "user",
  scope: vi.fn(),
  manager: vi.fn(),
  gate: vi.fn(),
  dispatch: vi.fn(),
  connect: vi.fn(),
  tools: [{ name: "write", _meta: { ui: { visibility: ["app"] } } }],
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "user-token",
}));
vi.mock("../../v1/convex-client.js", () => ({
  createConvexClient: () => ({ query: async () => ({ _id: state.userId }) }),
}));
vi.mock(
  "../../../utils/harness/forwarding/execution-control.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../utils/harness/forwarding/execution-control.js")
    >()),
    createExecutionControl: () => ({ widgetScope: state.scope }),
  }),
);
vi.mock("../auth.js", () => ({
  createAuthorizedManager: state.manager,
  callerContextFromHono: () => ({}),
}));
vi.mock("../../../utils/harness/forwarding/execution-gate.js", () => ({
  executeForwardedOperation: state.gate,
}));
vi.mock("../../../utils/harness/forwarding/approval.js", () => ({
  forwardingApproval: () => ({}),
}));
vi.mock("../../../utils/harness/forwarding/native-rpc-logs.js", () => ({
  createNativeRpcLogger: () => ({}),
}));
vi.mock("../../../utils/harness/harness-connection-profile.js", () => ({
  isModernAppsProfile: () => true,
}));
vi.mock("../../../utils/route-error-report.js", () => ({
  reportRouteFailure: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HARNESS_NATIVE_FORWARDING", "true");
  vi.stubEnv("HARNESS_FORWARDING_ORGANIZATION_IDS", "internal");
  state.userId = "user";
  state.tools = [{ name: "write", _meta: { ui: { visibility: ["app"] } } }];
  state.scope.mockResolvedValue({
    projectId: "project",
    organizationId: "internal",
    turnId: "turn",
    expiresAt: Date.now() + 60_000,
    hostConfig: {},
  });
  state.manager.mockResolvedValue({
    authorizedServerConfigs: { server: { url: "https://fixture.example/mcp" } },
    manager: {
      connectToServer: state.connect,
      listTools: async () => ({ tools: state.tools }),
      executeTool: state.dispatch,
      disconnectAllServers: async () => {},
    },
  });
  state.gate.mockImplementation(async ({ dispatch, operation }) =>
    dispatch(async () => {}, operation),
  );
  state.dispatch.mockResolvedValue({
    content: [{ type: "text", text: "updated" }],
    structuredContent: { count: 1 },
    _meta: { private: "widget-only" },
  });
});
afterEach(() => vi.unstubAllEnvs());

function request(signal?: AbortSignal) {
  return harnessWidgets.request("/widget", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      context: {
        owner: {
          kind: "chat",
          userId: "user",
          serverId: "server",
          harnessSessionId: "lane",
        },
        parentExecutionId: "parent",
      },
      toolName: "write",
      arguments: {},
    }),
  });
}

it("withdraws widget admission when forwarding is disabled", async () => {
  vi.stubEnv("HARNESS_NATIVE_FORWARDING", "false");
  expect((await request()).status).toBe(404);
  expect(state.scope).not.toHaveBeenCalled();
  expect(state.manager).not.toHaveBeenCalled();
});
it("withdraws widget admission when its organization is removed", async () => {
  vi.stubEnv("HARNESS_FORWARDING_ORGANIZATION_IDS", "another-org");
  expect((await request()).status).toBe(403);
  expect(state.manager).not.toHaveBeenCalled();
  expect(state.dispatch).not.toHaveBeenCalled();
});
it("rejects another user before resolving the parent", async () => {
  state.userId = "another-user";
  expect((await request()).status).toBe(403);
  expect(state.scope).not.toHaveBeenCalled();
});
it("rejects a stale parent before opening an upstream connection", async () => {
  state.scope.mockRejectedValue(new ExecutionControlError("invalid_parent"));
  expect((await request()).status).toBe(409);
  expect(state.manager).not.toHaveBeenCalled();
});
it("does not dispatch a model-only tool from an App", async () => {
  state.tools = [{ name: "write", _meta: { ui: { visibility: ["model"] } } }];
  const response = await request();
  expect(await response.text()).toContain('"type":"error"');
  expect(state.gate).not.toHaveBeenCalled();
  expect(state.dispatch).not.toHaveBeenCalled();
});
it("returns the unprojected App result only after the gate dispatches", async () => {
  const response = await request();
  expect(await response.text()).toContain('"_meta":{"private":"widget-only"}');
  expect(state.dispatch).toHaveBeenCalledTimes(1);
  expect(state.connect).toHaveBeenCalledWith(
    "server",
    { url: "https://fixture.example/mcp" },
    { signal: expect.any(AbortSignal) },
  );
  expect(state.gate.mock.calls[0][0].operation.method).toBe("tools/call");
});
it("does not dispatch when the approval gate refuses", async () => {
  state.gate.mockRejectedValue(new ExecutionControlError("approval_denied"));
  expect(await (await request()).text()).toContain('"type":"error"');
  expect(state.dispatch).not.toHaveBeenCalled();
});
it("passes request cancellation to the gate without dispatch", async () => {
  state.gate.mockImplementation(async ({ signal }) => signal.throwIfAborted());
  const abort = new AbortController();
  abort.abort();
  await (await request(abort.signal)).text();
  expect(state.gate.mock.calls[0][0].signal.aborted).toBe(true);
  expect(state.dispatch).not.toHaveBeenCalled();
});

it("cancels the active gate when its response stream is abandoned", async () => {
  let gateStarted = () => {};
  const started = new Promise<void>((resolve) => {
    gateStarted = resolve;
  });
  let gateSignal: AbortSignal | undefined;
  state.gate.mockImplementation(({ signal }) => {
    gateSignal = signal;
    gateStarted();
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  const response = await request();
  await started;
  await response.body?.cancel();
  expect(gateSignal?.aborted).toBe(true);
  expect(state.dispatch).not.toHaveBeenCalled();
});
