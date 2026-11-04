import { historyProvenanceContextFor, signToolResult, signAppResourceSource } from "../../../utils/history-provenance";
import { withRetainedResourceSource } from "@/shared/retained-app-resources";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { harnessWidgets } from "../harness-widget.js";
import { ExecutionControlError } from "../../../utils/harness/forwarding/execution-control.js";
import type { MrtrLegMiddleware } from "@mcpjam/sdk";

const state = vi.hoisted(() => ({
  userId: "user",
  scope: vi.fn(),
  control: vi.fn(),
  retained: vi.fn(),
  manager: vi.fn(),
  gate: vi.fn(),
  dispatch: vi.fn(),
  connect: vi.fn(),
  read: vi.fn(),
  resources: vi.fn(),
  templates: vi.fn(),
  collect: vi.fn(),
  inputGate: vi.fn(),
  ask: vi.fn(),
  tools: [{ name: "write", _meta: { ui: { visibility: ["app"] } } }],
}));
vi.mock("../../../utils/harness/forwarding/retained-resources", async original => ({...await original<typeof import("../../../utils/harness/forwarding/retained-resources")>(), readRetainedResourceScope: state.retained, retainedProfileFingerprint: () => "legacy-profile"}));
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
    createExecutionControl: state.control,
  }),
);
vi.mock("../auth.js", async original => ({
  ...await original<typeof import("../auth.js")>(),
  createAuthorizedManager: state.manager,
  callerContextFromHono: () => ({}),
}));
vi.mock("../../../utils/harness/forwarding/execution-gate.js", () => ({
  executeForwardedOperation: state.gate,
}));
vi.mock("../../../utils/harness/forwarding/approval.js", () => ({
  forwardingApproval: () => ({ binding: {}, ask: state.ask }),
}));
vi.mock("../../../utils/harness/forwarding/mrtr-gate.js", () => ({
  createForwardingMrtrGate: state.inputGate,
}));
vi.mock("../../../utils/harness/forwarding/native-rpc-logs.js", () => ({
  createNativeRpcLogger: () => ({}),
}));
vi.mock("../../../utils/harness/harness-connection-profile.js", () => ({
  isEnhancedMcpProfile: () => true,
}));
vi.mock("../../../utils/route-error-report.js", () => ({
  reportRouteFailure: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HARNESS_NATIVE_FORWARDING", "true");
  vi.stubEnv("HARNESS_FORWARDING_ORGANIZATION_IDS", "internal");
  state.userId = "user";
  state.control.mockImplementation(() => ({widgetScope: state.scope}));
  state.ask.mockImplementation(async ({ approvalId }) => ({
    approvalId,
    decision: "approved",
  }));
  state.inputGate.mockReturnValue(
    async ({ send }: { send: () => Promise<unknown> }) => send(),
  );
  state.tools = [{ name: "write", _meta: { ui: { visibility: ["app"] } } }];
  state.scope.mockResolvedValue({
    projectId: "project",
    organizationId: "internal",
    turnId: "turn",
    expiresAt: Date.now() + 60_000,
    hostConfig: {hostStyle:"claude"},
  });
  state.manager.mockResolvedValue({
    authorizedServerConfigs: { server: { url: "https://fixture.example/mcp" } },
    manager: {
      connectToServer: state.connect,
      listTools: async () => ({ tools: state.tools }),
      executeTool: state.dispatch,
      readResource: state.read,
      listResources: state.resources,
      listResourceTemplates: state.templates,
      getServerConfig: () => ({ url: "https://fixture.example/mcp" }),
      disconnectAllServers: async () => {},
      setMrtrInputCollector: state.collect,
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

function request(signal?: AbortSignal, inputVersion?: string) {
  return harnessWidgets.request("/widget", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(inputVersion
        ? { "x-mcpjam-harness-input-version": inputVersion }
        : {}),
    },
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
it("requires the owned-input browser before opening an eliciting widget connection", async () => {
  state.scope.mockResolvedValue({
    projectId: "project",
    organizationId: "internal",
    turnId: "turn",
    chatSessionId: "chat",
    expiresAt: Date.now() + 60_000,
    hostConfig: {hostStyle: "claude", clientCapabilities: { elicitation: { form: {} } } },
  });
  expect((await request()).status).toBe(409);
  expect(state.manager).not.toHaveBeenCalled();
  const response = await request(undefined, "1");
  expect(await response.text()).toContain('"type":"result"');
  expect(state.collect).toHaveBeenCalledWith(
    "server",
    expect.any(Function),
    expect.objectContaining({ aroundLeg: expect.any(Function) }),
  );
});
it("presents parent and continuation approvals through the same widget stream", async () => {
  state.scope.mockResolvedValue({
    projectId: "project",
    organizationId: "internal",
    turnId: "turn",
    chatSessionId: "chat",
    expiresAt: Date.now() + 60_000,
    hostConfig: {hostStyle: "claude", clientCapabilities: { elicitation: { form: {} } } },
  });
  state.gate.mockImplementation(async ({ approval, dispatch, operation }) => {
    expect(state.inputGate.mock.calls[0][0].approval).toBe(approval);
    for (const executionId of ["parent", "continuation"])
      await approval.ask({
        executionId,
        approvalId: executionId,
        signal: new AbortController().signal,
      });
    return dispatch(async () => {}, operation);
  });
  const text = await (await request(undefined, "1")).text();
  expect(text.match(/"type":"approval"/g)).toHaveLength(2);
  expect(text).toContain("continuation");
  expect(text).toContain('"type":"result"');
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
it("stops cancelled requests before connecting or dispatching", async () => {
  state.gate.mockImplementation(async ({ signal }) => signal.throwIfAborted());
  const abort = new AbortController();
  abort.abort();
  await (await request(abort.signal)).text();
  expect(state.gate).not.toHaveBeenCalled();
  expect(state.connect).not.toHaveBeenCalled();
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


const boundResource = (operation: object) => harnessWidgets.request("/widget-resources", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ context: { owner: { kind: "chat", userId: "user", serverId: "server", connectionId: "original-account", harnessSessionId: "lane" }, parentExecutionId: "parent" }, operation }),
});
it("uses the original account and trusted host for resource reads", async () => {
  const scope = await state.scope(); state.scope.mockClear();
  state.scope.mockResolvedValue({ ...scope, hostConfig: { hostStyle: "claude", connectionDefaults: { requestTimeout: 4321 } } });
  state.read.mockResolvedValue({ contents: [{ uri: "test://record", text: "original account" }] });
  const response = await boundResource({ method: "resources/read", uri: "test://record", _meta: { progressToken: "progress" } });
  expect(response.status).toBe(200);
  expect(state.manager.mock.calls[0][7].connectionIds).toEqual({ server: "original-account" });
  expect(state.manager.mock.calls[0][4]).toBe(4321);
  expect(state.read).toHaveBeenCalledWith("server", { uri: "test://record", _meta: { progressToken: "progress" } }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(state.scope).toHaveBeenCalledTimes(3);
});
it("binds eliciting resource legs to the parent without requiring a tool frame", async () => {
  const scope = await state.scope();
  state.scope.mockClear();
  state.scope.mockResolvedValue({
    ...scope,
    chatSessionId: "chat",
    hostConfig: {
      hostStyle: "codex",
      clientCapabilities: { elicitation: { form: {} } },
      mcpProfile: { apps: { mcpAppsOverrides: { serverResources: true } } },
    },
  });
  state.read.mockImplementation(async () => {
    const middleware: MrtrLegMiddleware =
      state.collect.mock.calls[0][2].aroundLeg;
    for (const round of [0, 1])
      await middleware({
        operationId: "resource",
        round,
        request: { method: "resources/read", params: { uri: "test://record" } },
        send: async () => ({}),
      });
    return { contents: [{ uri: "test://record", text: "bound" }] };
  });
  const response = await harnessWidgets.request("/widget-resources", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mcpjam-harness-input-version": "1",
    },
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
      operation: { method: "resources/read", uri: "test://record" },
    }),
  });
  expect(response.status).toBe(200);
  expect(state.inputGate).not.toHaveBeenCalled();
  expect(state.scope).toHaveBeenCalledTimes(7);
});
it("rechecks authority after connecting and before a resource call", async () => {
  const scope = await state.scope(); state.scope.mockReset();
  state.scope.mockResolvedValueOnce({ ...scope, hostConfig: { hostStyle: "claude" } }).mockRejectedValueOnce(new ExecutionControlError("revoked"));
  const response = await boundResource({ method: "resources/read", uri: "test://record" });
  expect(response.status).toBe(409);
  expect(state.read).not.toHaveBeenCalled();
});
it("does not return resource data after authority changes during a read", async () => {
  const scope = await state.scope(); state.scope.mockReset();
  state.scope.mockResolvedValueOnce({ ...scope, hostConfig: { hostStyle: "claude" } }).mockResolvedValueOnce(scope).mockRejectedValueOnce(new ExecutionControlError("revoked"));
  state.read.mockResolvedValue({ contents: [{ uri: "test://record", text: "private resource" }] });
  const response = await boundResource({ method: "resources/read", uri: "test://record" });
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("private resource");
  expect(state.read).toHaveBeenCalledOnce();
});
it("loads initial widget HTML using the same bound resource route", async () => {
  const scope = await state.scope(); state.scope.mockClear();
  state.scope.mockResolvedValue({ ...scope, hostConfig: { hostStyle: "claude", mcpProfile: { apps: { mcpAppsOverrides: { serverResources: false } } } } });
  state.read.mockResolvedValue({ contents: [{ uri: "ui://app", mimeType: "text/html;profile=mcp-app", text: "<p>Original App</p>", _meta: { ui: { csp: { connectDomains: [] } } } }] });
  state.resources.mockResolvedValue({ resources: [] });
  const response = await boundResource({ method: "widget/content", request: { serverId: "server", resourceUri: "ui://app", toolId: "call", toolName: "app", toolInput: {}, injectOpenAiCompat: true, cspMode: "permissive", template: "ui://app" } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ html: expect.stringContaining("Original App"), mimeTypeValid: true, injectedOpenAiCompat: true, permissive: true });
  expect(state.manager.mock.calls[0][7].connectionIds).toEqual({ server: "original-account" });
});

function retainedProof(connectionCapabilities?: Record<string, unknown>) {
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
  vi.stubEnv("HISTORY_PROVENANCE_SECRET", "retained-resource-unit-test-secret");
  const source = {version: 1 as const, profile: "legacy-profile", ...(connectionCapabilities ? {connectionCapabilities} : {}), toolCallId: "call", turnId: "real-turn", owner: {kind: "chat" as const, userId: "user", serverId: "server", connectionId: "original-account", harnessSessionId: "lane"}, digest: "original-digest", projectId: "project", chatSessionId: "chat"};
  state.retained.mockResolvedValue({binding: source, organizationId: "internal", expiresAt: Date.now() + 60000, hostConfig: {hostStyle: "claude"}});
  const claim = {toolCallId: "call", toolName: "qa_read", input: {}, output: withRetainedResourceSource({content: [{type: "text", text: "App"}]}, {...source, attestation: signAppResourceSource(historyProvenanceContextFor("project", "chat")!, source)!})};
  return {claim, signature: signToolResult(historyProvenanceContextFor("project", "chat")!, claim)!};
}
const retainedResource = (context: object) => harnessWidgets.request("/widget-resources", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({context, operation: {method: "resources/read", uri: "test://account"}})});
it("verifies the bridge presentation proof and uses only the original connection", async () => {
  const response = await retainedResource(retainedProof());
  expect(response.status).toBe(200);
  expect(state.manager.mock.calls[0][7]).toMatchObject({connectionIds: {server: "original-account"}, onlySelectedConnections: true});
  expect(state.retained).toHaveBeenCalledTimes(3);
  expect(state.retained.mock.calls.every(([, digest]) => digest === "original-digest")).toBe(true);
});
it.each(["signature", "call", "input", "output", "user", "chat"])("refuses changed bridge %s without dispatch", async change => {
  const proof = retainedProof();
  if (change === "signature") proof.signature = "forged";
  if (change === "call") proof.claim.toolCallId = "another";
  if (change === "input") proof.claim.input = {changed: true};
  if (change === "output") proof.claim.output = {content: [], changed: true};
  if (change === "user") state.userId = "another-user";
  if (change === "chat") state.retained.mockResolvedValue({...(await state.retained()), binding: {...(await state.retained()).binding, chatSessionId: "another-chat"}});
  const response = await retainedResource(proof);
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(state.manager).not.toHaveBeenCalled();
  expect(state.read).not.toHaveBeenCalled();
});
it("discards a bridge read if its original authority changes during the request", async () => {
  const proof = retainedProof();
  const scope = await state.retained(); state.retained.mockReset();
  state.retained.mockResolvedValueOnce(scope).mockResolvedValueOnce(scope).mockRejectedValueOnce(new ExecutionControlError("scope_mismatch"));
  const response = await retainedResource(proof);
  expect(response.status).toBe(409);
  expect(state.read).toHaveBeenCalledTimes(1);
});
it("does not treat a signed server result as host authority to invent an account source", async () => {
  const proof = retainedProof();
  const envelope = proof.claim.output;
  const parsed = (await import("@/shared/retained-app-resources")).readRetainedResourceSource(envelope);
  if (!parsed) throw Error("Missing source fixture");
  proof.claim.output = withRetainedResourceSource(envelope, {...parsed, owner: {...parsed.owner, connectionId: "another-account"}});
  proof.signature = signToolResult(historyProvenanceContextFor("project", "chat")!, proof.claim)!;
  const response = await retainedResource(proof);
  expect(response.status).toBe(409);
  expect(state.retained).not.toHaveBeenCalled();
  expect(state.manager).not.toHaveBeenCalled();
});
it("reads through the selected non-default connection's actual manager key", async () => {
  const scope = await state.scope(); state.scope.mockClear();
  state.scope.mockResolvedValue({...scope, hostConfig: {hostStyle: "claude"}});
  const authorized = await state.manager(); state.manager.mockClear();
  state.manager.mockResolvedValue({...authorized, authorizedServerConfigs: {alternate: {url: "https://fixture.example/mcp"}}, connectionsByServerId: {server: [{serverId: "server", connectionId: "original-account", key: "alternate", label: "B", isDefault: false}]}});
  const response = await boundResource({method: "resources/read", uri: "test://account"});
  expect(response.status).toBe(200);
  expect(state.connect.mock.calls[0][0]).toBe("alternate");
  expect(state.read.mock.calls[0][0]).toBe("alternate");
});


it("routes a retained App button through the existing widget gate with its exact parent and account", async () => {
  const proof = retainedProof();
  const response = await harnessWidgets.request("/widget", {method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({context:proof,toolName:"write",arguments:{value:1}})});
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('"type":"result"');
  expect(state.control).toHaveBeenCalledWith(expect.objectContaining({retainedParent:{toolCallId:"call",turnId:"real-turn",scopeDigest:"original-digest"}}));
  expect(state.manager.mock.calls[0][7]).toMatchObject({connectionIds:{server:"original-account"},onlySelectedConnections:true});
  expect(state.gate).toHaveBeenCalledOnce();
  expect(state.dispatch).toHaveBeenCalledOnce();
});
it("refuses retained App tools when the host disables serverTools", async () => {
  const proof=retainedProof();
  state.retained.mockResolvedValue({...await state.retained(),hostConfig:{hostStyle:"claude",mcpProfile:{apps:{mcpAppsOverrides:{serverTools:false}}}}});
  const response=await harnessWidgets.request("/widget",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({context:proof,toolName:"write",arguments:{}})});
  expect(response.status).toBe(409);
  expect(state.gate).not.toHaveBeenCalled();
  expect(state.dispatch).not.toHaveBeenCalled();
});
it("checks tool visibility again after approval before sending a retained write", async () => {
  const proof=retainedProof();
  state.gate.mockImplementation(async ({dispatch,operation})=>{state.tools=[{name:"write",_meta:{ui:{visibility:["model"]}}}];return dispatch(async()=>{},operation);});
  const response=await harnessWidgets.request("/widget",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({context:proof,toolName:"write",arguments:{}})});
  expect(await response.text()).toContain('"type":"error"');
  expect(state.dispatch).not.toHaveBeenCalled();
});


it("does not write when account authority changes during the final catalog lookup", async () => {
  const proof=retainedProof();
  const authorized=await state.manager();
  let lists=0;
  authorized.manager.listTools=async()=>{if(++lists===2)state.retained.mockRejectedValue(new ExecutionControlError("scope_mismatch"));return {tools:state.tools};};
  const response=await harnessWidgets.request("/widget",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({context:proof,toolName:"write",arguments:{}})});
  expect(await response.text()).toContain('"type":"error"');
  expect(lists).toBe(2);
  expect(state.dispatch).not.toHaveBeenCalled();
});
it("does not open a server when the App request is cancelled during authorization", async () => {
  const proof=retainedProof();
  const abort=new AbortController();
  const authorized=await state.manager();
  state.manager.mockImplementationOnce(async()=>{abort.abort();return authorized;});
  const response=await harnessWidgets.request(new Request("http://localhost/widget",{method:"POST",headers:{"content-type":"application/json"},signal:abort.signal,body:JSON.stringify({context:proof,toolName:"write",arguments:{}})}));
  await response.text();
  expect(state.connect).not.toHaveBeenCalled();
  expect(state.dispatch).not.toHaveBeenCalled();
});

it("reconnects with the signed negotiated capabilities instead of re-advertising withheld host claims", async () => {
  const negotiated = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
  const proof = retainedProof(negotiated);
  const scope = await state.retained();
  state.retained.mockResolvedValue({...scope, hostConfig: {...scope.hostConfig, clientCapabilities: {...negotiated, experimental: {withheld: true}}}});
  const response = await retainedResource(proof);
  expect(response.status).toBe(200);
  expect(state.manager.mock.calls[0][6]).toEqual(negotiated);
});
it("rejects capabilities added to a retained source even with a newly signed result", async () => {
  const proof = retainedProof({extensions: {}});
  const {readRetainedResourceSource} = await import("@/shared/retained-app-resources");
  const source = readRetainedResourceSource(proof.claim.output);
  if (!source) throw Error("Missing source fixture");
  proof.claim.output = withRetainedResourceSource(proof.claim.output, {...source, connectionCapabilities: {experimental: {forged: true}}});
  proof.signature = signToolResult(historyProvenanceContextFor("project", "chat")!, proof.claim)!;
  expect((await retainedResource(proof)).status).toBe(409);
  expect(state.manager).not.toHaveBeenCalled();
});
