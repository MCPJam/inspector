import {
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
} from "@modelcontextprotocol/client";
import { MCPClientManager } from "../src/mcp-client-manager";
import { ElicitationManager } from "../src/mcp-client-manager/elicitation";
import {
  createElicitationTimeoutSuspension,
  ELICITATION_WATCHDOG_INTERVAL_MS,
} from "../src/mcp-client-manager/elicitation-timeout";
import { isRetryableTransientError } from "../src/retry";
import {
  isNonRetryableMarkedError,
  markNonRetryableError,
} from "../src/mcp-client-manager/error-utils";
import type { ManagedMcpClient } from "../src/mcp-client-manager/managed-mcp-client";

const ELICIT_METHOD = "elicitation/create";

/**
 * Minimal ManagedMcpClient stand-in that just records request handlers so a
 * test can drive `elicitation/create` straight at them.
 */
function createHandlerCapturingClient() {
  const handlers = new Map<string, (request: any, ctx?: any) => Promise<any>>();
  const client = {
    setRequestHandler: (method: string, handler: any) => {
      handlers.set(method, handler);
    },
    removeRequestHandler: (method: string) => {
      handlers.delete(method);
    },
  } as unknown as ManagedMcpClient;

  return {
    client,
    hasElicitHandler: () => handlers.has(ELICIT_METHOD),
    elicit: (params: unknown) => {
      const handler = handlers.get(ELICIT_METHOD);
      if (!handler) throw new Error("no elicitation handler registered");
      return handler({ method: ELICIT_METHOD, params }, {});
    },
  };
}

function seedRegisteredServer(
  manager: MCPClientManager,
  serverId: string,
  config: Record<string, unknown>,
  timeout = 1000
): void {
  (manager as any).registeredServers.set(serverId, { config, timeout });
}

function seedLiveState(
  manager: MCPClientManager,
  serverId: string,
  liveState: Record<string, unknown>
): void {
  (manager as any).liveClientStates.set(serverId, liveState);
}

describe("elicitation callback passthrough", () => {
  it("passes serverId, mode, url and elicitationId through to the global callback", async () => {
    const manager = new ElicitationManager();
    const received: any[] = [];
    manager.setGlobalCallback(async (request) => {
      received.push(request);
      return { action: "accept" } as any;
    });

    const fake = createHandlerCapturingClient();
    manager.applyToClient("srv", fake.client, { form: {}, url: {} });

    await fake.elicit({
      mode: "url",
      message: "Sign in to continue",
      url: "https://example.com/authorize",
      elicitationId: "server-chosen-id",
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      serverId: "srv",
      mode: "url",
      message: "Sign in to continue",
      url: "https://example.com/authorize",
      elicitationId: "server-chosen-id",
    });
    expect(received[0].requestId).toEqual(expect.any(String));
  });

  it("treats an absent mode as form and keeps reading requestedSchema", async () => {
    const manager = new ElicitationManager();
    const received: any[] = [];
    manager.setGlobalCallback(async (request) => {
      received.push(request);
      return { action: "decline" } as any;
    });

    const fake = createHandlerCapturingClient();
    manager.applyToClient("srv", fake.client, {});

    const requestedSchema = { type: "object", properties: { name: {} } };
    await fake.elicit({ message: "Your name?", requestedSchema });

    expect(received[0]).toMatchObject({
      serverId: "srv",
      mode: "form",
      message: "Your name?",
      schema: requestedSchema,
    });
    expect(received[0].url).toBeUndefined();
    expect(received[0].elicitationId).toBeUndefined();
  });

  it("still falls back to the legacy `schema` alias in form mode", async () => {
    const manager = new ElicitationManager();
    const received: any[] = [];
    manager.setGlobalCallback(async (request) => {
      received.push(request);
      return { action: "cancel" } as any;
    });

    const fake = createHandlerCapturingClient();
    manager.applyToClient("srv", fake.client, { form: {} });

    const schema = { type: "object" };
    await fake.elicit({ mode: "form", message: "hi", schema });

    expect(received[0].schema).toBe(schema);
  });

  it("forwards the related task id from _meta", async () => {
    const manager = new ElicitationManager();
    const received: any[] = [];
    manager.setGlobalCallback(async (request) => {
      received.push(request);
      return { action: "cancel" } as any;
    });

    const fake = createHandlerCapturingClient();
    manager.applyToClient("srv", fake.client, {});

    await fake.elicit({
      message: "hi",
      _meta: { "io.modelcontextprotocol/related-task": { taskId: "task-1" } },
    });

    expect(received[0].relatedTaskId).toBe("task-1");
  });
});

describe("elicitation declared-mode enforcement (-32602)", () => {
  async function expectInvalidParams(promise: Promise<unknown>) {
    await expect(promise).rejects.toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
    });
    await promise.catch((error) => {
      // Spec MUST: rejection crosses the wire as JSON-RPC -32602.
      expect(error.code).toBe(-32602);
    });
  }

  function setup(declared: Record<string, unknown> | undefined) {
    const manager = new ElicitationManager();
    const callback = jest.fn(async () => ({ action: "accept" } as any));
    manager.setGlobalCallback(callback);
    const fake = createHandlerCapturingClient();
    manager.applyToClient("srv", fake.client, declared);
    return { manager, callback, fake };
  }

  it("rejects a url-mode request when the declared capability is bare {} (form-only)", async () => {
    const { callback, fake } = setup({});
    await expectInvalidParams(
      fake.elicit({ mode: "url", message: "go", url: "https://example.com" })
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it("rejects a url-mode request when only form is declared", async () => {
    const { callback, fake } = setup({ form: {} });
    await expectInvalidParams(
      fake.elicit({ mode: "url", message: "go", url: "https://example.com" })
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it("allows both modes when {form:{},url:{}} is declared", async () => {
    const { callback, fake } = setup({ form: {}, url: {} });
    await expect(
      fake.elicit({ mode: "url", message: "go", url: "https://example.com" })
    ).resolves.toEqual({ action: "accept" });
    await expect(fake.elicit({ message: "go" })).resolves.toEqual({
      action: "accept",
    });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("rejects a form-mode request when only url is declared", async () => {
    const { callback, fake } = setup({ url: {} });
    await expectInvalidParams(fake.elicit({ mode: "form", message: "go" }));
    await expectInvalidParams(fake.elicit({ message: "go" }));
    expect(callback).not.toHaveBeenCalled();
  });

  it("allows form but rejects url when no declaration is on record", async () => {
    const { callback, fake } = setup(undefined);
    await expect(fake.elicit({ message: "go" })).resolves.toEqual({
      action: "accept",
    });
    await expectInvalidParams(
      fake.elicit({ mode: "url", message: "go", url: "https://example.com" })
    );
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("rejects an unrecognized mode", async () => {
    const { callback, fake } = setup({ form: {}, url: {} });
    await expectInvalidParams(fake.elicit({ mode: "carrier-pigeon" }));
    expect(callback).not.toHaveBeenCalled();
  });

  it("enforces declared modes on the server-specific handler branch too", async () => {
    const manager = new ElicitationManager();
    const handler = jest.fn(async () => ({ action: "accept" } as any));
    manager.setHandler("srv", handler);
    const fake = createHandlerCapturingClient();
    manager.applyToClient("srv", fake.client, { form: {} });

    await expectInvalidParams(
      fake.elicit({ mode: "url", message: "go", url: "https://example.com" })
    );
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("hasPendingForServer", () => {
  it("is true only while the global callback is in flight", async () => {
    const manager = new ElicitationManager();
    let release!: (value: any) => void;
    manager.setGlobalCallback(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );

    const fake = createHandlerCapturingClient();
    manager.applyToClient("srv", fake.client, {});

    expect(manager.hasPendingForServer("srv")).toBe(false);
    const inFlight = fake.elicit({ message: "hi" });
    await Promise.resolve();
    expect(manager.hasPendingForServer("srv")).toBe(true);
    expect(manager.hasPendingForServer("other")).toBe(false);

    release({ action: "cancel" });
    await inFlight;
    expect(manager.hasPendingForServer("srv")).toBe(false);
  });

  it("is true only while a server-specific handler is in flight", async () => {
    const manager = new ElicitationManager();
    let release!: (value: any) => void;
    manager.setHandler(
      "srv",
      () =>
        new Promise((resolve) => {
          release = resolve;
        }) as any
    );

    const fake = createHandlerCapturingClient();
    manager.applyToClient("srv", fake.client, {});

    const inFlight = fake.elicit({ message: "hi" });
    await Promise.resolve();
    expect(manager.hasPendingForServer("srv")).toBe(true);

    release({ action: "cancel" });
    await inFlight;
    expect(manager.hasPendingForServer("srv")).toBe(false);
  });

  it("counts concurrent elicitations and clears only when all settle", async () => {
    const manager = new ElicitationManager();
    const releases: Array<(value: any) => void> = [];
    manager.setGlobalCallback(
      () => new Promise((resolve) => releases.push(resolve))
    );

    const fake = createHandlerCapturingClient();
    manager.applyToClient("srv", fake.client, {});

    const first = fake.elicit({ message: "a" });
    const second = fake.elicit({ message: "b" });
    await Promise.resolve();
    expect(manager.hasPendingForServer("srv")).toBe(true);

    releases[0]({ action: "cancel" });
    await first;
    expect(manager.hasPendingForServer("srv")).toBe(true);

    releases[1]({ action: "cancel" });
    await second;
    expect(manager.hasPendingForServer("srv")).toBe(false);
  });

  it("clears the pending count when the callback throws", async () => {
    const manager = new ElicitationManager();
    manager.setGlobalCallback(async () => {
      throw new Error("callback exploded");
    });

    const fake = createHandlerCapturingClient();
    manager.applyToClient("srv", fake.client, {});

    await expect(fake.elicit({ message: "hi" })).rejects.toThrow(
      "callback exploded"
    );
    expect(manager.hasPendingForServer("srv")).toBe(false);
  });

  it("does not count a request rejected for an undeclared mode", async () => {
    const manager = new ElicitationManager();
    manager.setGlobalCallback(() => new Promise(() => {}));

    const fake = createHandlerCapturingClient();
    manager.applyToClient("srv", fake.client, {});

    await expect(
      fake.elicit({ mode: "url", message: "go", url: "https://example.com" })
    ).rejects.toMatchObject({ code: -32602 });
    expect(manager.hasPendingForServer("srv")).toBe(false);
  });
});

describe("buildCapabilities elicitation shape", () => {
  function buildCapabilities(
    manager: MCPClientManager,
    serverId: string,
    config: Record<string, unknown>
  ) {
    return (manager as any).buildCapabilities(serverId, config) as Record<
      string,
      unknown
    >;
  }

  it("preserves an explicit {form:{},url:{}} verbatim when a callback is registered", () => {
    const manager = new MCPClientManager();
    manager.setElicitationCallback(() => ({ action: "cancel" } as any));

    const capabilities = buildCapabilities(manager, "srv", {
      url: "https://example.com/mcp",
      clientCapabilities: { elicitation: { form: {}, url: {} } },
    });

    expect(capabilities.elicitation).toEqual({ form: {}, url: {} });
  });

  it("preserves a bare {} elicitation verbatim when a callback is registered", () => {
    const manager = new MCPClientManager();
    manager.setElicitationCallback(() => ({ action: "cancel" } as any));

    const capabilities = buildCapabilities(manager, "srv", {
      url: "https://example.com/mcp",
      clientCapabilities: { elicitation: {} },
    });

    expect(capabilities.elicitation).toEqual({});
  });

  it("strips an explicit {form:{},url:{}} when no callback is registered", () => {
    const manager = new MCPClientManager();

    const capabilities = buildCapabilities(manager, "srv", {
      url: "https://example.com/mcp",
      clientCapabilities: { elicitation: { form: {}, url: {} } },
    });

    expect(capabilities).not.toHaveProperty("elicitation");
  });

  it("strips elicitation when only a different server has a handler", () => {
    const manager = new MCPClientManager();
    (manager as any).registeredServers.set("other", { config: {}, timeout: 1 });
    manager.setElicitationHandler("other", () => ({ action: "cancel" } as any));

    const capabilities = buildCapabilities(manager, "srv", {
      url: "https://example.com/mcp",
      clientCapabilities: { elicitation: { form: {}, url: {} } },
    });

    expect(capabilities).not.toHaveProperty("elicitation");
  });
});

describe("non-retryable marker", () => {
  it("is not forgeable through the prototype chain", () => {
    // A string-keyed marker was read with plain property access, so ANY error
    // inheriting a truthy `__mcpjamNonRetryable` — including via prototype
    // pollution — silently suppressed legitimate retries. Set membership can't
    // be inherited.
    const impostor = Object.create({ __mcpjamNonRetryable: true }) as object;
    expect(isNonRetryableMarkedError(impostor)).toBe(false);

    const polluted = new Error("transient");
    (polluted as unknown as Record<string, unknown>).__mcpjamNonRetryable = true;
    expect(isNonRetryableMarkedError(polluted)).toBe(false);
  });

  it("marks only the exact error object handed to it", () => {
    const marked = markNonRetryableError(new Error("verdict"));
    expect(isNonRetryableMarkedError(marked)).toBe(true);
    expect(isNonRetryableMarkedError(new Error("verdict"))).toBe(false);
  });

  it("stamps nothing onto the error it marks", () => {
    // We don't own these objects; a marker property would leak into anything
    // that serializes or enumerates them.
    const error = markNonRetryableError(new Error("verdict"));
    expect(Object.keys(error)).not.toContain("__mcpjamNonRetryable");
    expect(
      Object.getOwnPropertyNames(error).some((k) => k.includes("Retryable")),
    ).toBe(false);
  });

  it.each([[null], [undefined], ["str"], [42]])("is false for %p", (v) => {
    expect(isNonRetryableMarkedError(v)).toBe(false);
  });
});

describe("createElicitationTimeoutSuspension", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not abort while an elicitation is pending, even far past the base budget", async () => {
    const suspension = createElicitationTimeoutSuspension({
      serverId: "srv",
      baseTimeoutMs: 1_000,
      extensionMs: 600_000,
      hasPending: () => true,
    });

    await jest.advanceTimersByTimeAsync(120_000);
    expect(suspension.signal.aborted).toBe(false);
    suspension.dispose();
  });

  it("honors a per-call timeout SHORTER than the watchdog sample interval", async () => {
    // The bug: we raise the upstream timeout to base+extension immediately, so
    // the watchdog is the only thing enforcing `base`. Sampling at a fixed 1s
    // meant a caller asking for 100ms wasn't stopped until 1s — a 10x overrun
    // of a budget they explicitly set.
    const suspension = createElicitationTimeoutSuspension({
      serverId: "srv",
      baseTimeoutMs: 100,
      extensionMs: 600_000,
      hasPending: () => false,
    });

    await jest.advanceTimersByTimeAsync(99);
    expect(suspension.signal.aborted).toBe(false);

    // Fires on ITS budget, not on the sampler's cadence.
    await jest.advanceTimersByTimeAsync(2);
    expect(suspension.signal.aborted).toBe(true);
    suspension.dispose();
  });

  it("still pauses a short budget while an elicitation is pending", async () => {
    // The short-timeout fix must not cost the suspension itself: a 100ms budget
    // with a human mid-form should not fire at 100ms.
    let pending = true;
    const suspension = createElicitationTimeoutSuspension({
      serverId: "srv",
      baseTimeoutMs: 100,
      extensionMs: 600_000,
      hasPending: () => pending,
    });

    await jest.advanceTimersByTimeAsync(30_000);
    expect(suspension.signal.aborted).toBe(false);

    pending = false;
    await jest.advanceTimersByTimeAsync(101);
    expect(suspension.signal.aborted).toBe(true);
    suspension.dispose();
  });

  it("aborts at the base budget when nothing is pending", async () => {
    const suspension = createElicitationTimeoutSuspension({
      serverId: "srv",
      baseTimeoutMs: 5_000,
      extensionMs: 600_000,
      hasPending: () => false,
    });

    await jest.advanceTimersByTimeAsync(4_000);
    expect(suspension.signal.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(suspension.signal.aborted).toBe(true);
    expect(suspension.signal.reason).toBeInstanceOf(SdkError);
    expect(suspension.signal.reason.code).toBe(SdkErrorCode.RequestTimeout);
    expect(suspension.signal.reason.data).toMatchObject({
      serverId: "srv",
      reason: "server-timeout",
    });
    suspension.dispose();
  });

  it("resumes the active clock after an elicitation settles", async () => {
    let pending = true;
    const suspension = createElicitationTimeoutSuspension({
      serverId: "srv",
      baseTimeoutMs: 5_000,
      extensionMs: 600_000,
      hasPending: () => pending,
    });

    // 60s suspended: the active clock must not have moved.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(suspension.signal.aborted).toBe(false);

    pending = false;
    await jest.advanceTimersByTimeAsync(4_000);
    expect(suspension.signal.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(suspension.signal.aborted).toBe(true);
    suspension.dispose();
  });

  it("aborts when the cumulative suspended budget is exhausted", async () => {
    const suspension = createElicitationTimeoutSuspension({
      serverId: "srv",
      baseTimeoutMs: 120_000,
      extensionMs: 10_000,
      hasPending: () => true,
    });

    await jest.advanceTimersByTimeAsync(9_000);
    expect(suspension.signal.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(suspension.signal.aborted).toBe(true);
    expect(suspension.signal.reason.data).toMatchObject({
      reason: "elicitation-budget",
      timeout: 10_000,
    });
    suspension.dispose();
  });

  it("accumulates the suspended budget across sequential elicitations", async () => {
    let pending = true;
    const suspension = createElicitationTimeoutSuspension({
      serverId: "srv",
      baseTimeoutMs: 120_000,
      extensionMs: 10_000,
      hasPending: () => pending,
    });

    // First elicitation: 6s suspended.
    await jest.advanceTimersByTimeAsync(6_000);
    pending = false;
    await jest.advanceTimersByTimeAsync(2_000);
    expect(suspension.signal.aborted).toBe(false);

    // Second elicitation: 6s more suspended pushes the cumulative total over.
    pending = true;
    await jest.advanceTimersByTimeAsync(6_000);
    expect(suspension.signal.aborted).toBe(true);
    expect(suspension.signal.reason.data).toMatchObject({
      reason: "elicitation-budget",
    });
    suspension.dispose();
  });

  it("raises a timeout-shaped error that is never classified retryable", async () => {
    const suspension = createElicitationTimeoutSuspension({
      serverId: "srv",
      baseTimeoutMs: 1_000,
      extensionMs: 600_000,
      hasPending: () => false,
    });

    await jest.advanceTimersByTimeAsync(2_000);
    const reason = suspension.signal.reason;

    // Timeout-shaped for callers...
    expect(reason).toBeInstanceOf(SdkError);
    expect(reason.code).toBe(SdkErrorCode.RequestTimeout);
    expect(reason.message).toMatch(/timed out/i);
    // ...but a deliberate verdict, never a transient to retry, despite the
    // message matching the classifier's "timed out" heuristic.
    expect(isRetryableTransientError(reason)).toBe(false);
    suspension.dispose();
  });

  it("composes the caller's signal without clobbering it", async () => {
    const caller = new AbortController();
    const suspension = createElicitationTimeoutSuspension({
      serverId: "srv",
      baseTimeoutMs: 600_000,
      extensionMs: 600_000,
      hasPending: () => false,
      callerSignal: caller.signal,
    });

    expect(suspension.signal.aborted).toBe(false);
    const reason = new Error("caller went away");
    caller.abort(reason);
    await Promise.resolve();

    expect(suspension.signal.aborted).toBe(true);
    expect(suspension.signal.reason).toBe(reason);
    suspension.dispose();
  });

  it("surfaces an already-aborted caller signal immediately", () => {
    const caller = new AbortController();
    caller.abort(new Error("already gone"));
    const suspension = createElicitationTimeoutSuspension({
      serverId: "srv",
      baseTimeoutMs: 600_000,
      extensionMs: 600_000,
      hasPending: () => false,
      callerSignal: caller.signal,
    });

    expect(suspension.signal.aborted).toBe(true);
    suspension.dispose();
  });

  it("dispose clears the watchdog interval and stops the clock", async () => {
    const before = jest.getTimerCount();
    const suspension = createElicitationTimeoutSuspension({
      serverId: "srv",
      baseTimeoutMs: 1_000,
      extensionMs: 600_000,
      hasPending: () => false,
      intervalMs: ELICITATION_WATCHDOG_INTERVAL_MS,
    });
    expect(jest.getTimerCount()).toBe(before + 1);

    suspension.dispose();
    expect(jest.getTimerCount()).toBe(before);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(suspension.signal.aborted).toBe(false);

    // Idempotent.
    expect(() => suspension.dispose()).not.toThrow();
  });
});

describe("executeTool elicitation-aware timeout", () => {
  const SERVER = "srv";

  function buildManager(options: Record<string, unknown> = {}) {
    const manager = new MCPClientManager({}, options as any);
    seedRegisteredServer(
      manager,
      SERVER,
      { url: "https://example.com/mcp" },
      1_000
    );
    return manager;
  }

  function attachClient(manager: MCPClientManager, callTool: any) {
    const client = { callTool };
    seedLiveState(manager, SERVER, { client });
    return client;
  }

  function setPending(manager: MCPClientManager, pending: () => boolean) {
    jest
      .spyOn((manager as any).elicitationManager, "hasPendingForServer")
      .mockImplementation(() => pending());
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("is a pure passthrough when the server has no elicitation handler", async () => {
    const manager = buildManager();
    const callTool = jest.fn().mockResolvedValue({ content: [] });
    attachClient(manager, callTool);

    await expect(manager.executeTool(SERVER, "add", { a: 1 })).resolves.toEqual(
      {
        content: [],
      }
    );

    const options = callTool.mock.calls[0][1];
    // Untouched: the registered timeout, and no watchdog signal injected.
    expect(options.timeout).toBe(1_000);
    expect(options.signal).toBeUndefined();
  });

  it("overrides the upstream timeout to base + extension once a handler exists", async () => {
    const manager = buildManager({ elicitationTimeoutExtensionMs: 60_000 });
    manager.setElicitationCallback(() => ({ action: "cancel" } as any));
    const callTool = jest.fn().mockResolvedValue({ content: [] });
    attachClient(manager, callTool);

    await manager.executeTool(SERVER, "add", { a: 1 });

    const options = callTool.mock.calls[0][1];
    // `withTimeout` only injects when unset, so this has to be an override.
    expect(options.timeout).toBe(61_000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("survives past the base timeout while an elicitation is pending", async () => {
    const manager = buildManager({ elicitationTimeoutExtensionMs: 600_000 });
    manager.setElicitationCallback(() => ({ action: "cancel" } as any));

    let resolveCall!: (value: unknown) => void;
    let received: AbortSignal | undefined;
    const callTool = jest.fn((_params: unknown, options: any) => {
      received = options.signal;
      return new Promise((resolve) => {
        resolveCall = resolve;
      });
    });
    attachClient(manager, callTool);
    setPending(manager, () => true);

    const inFlight = manager.executeTool(SERVER, "add", { a: 1 });
    const settled = jest.fn();
    void inFlight.then(settled, settled);

    // 120x the 1s base budget, all of it suspended on a human.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(received!.aborted).toBe(false);
    expect(settled).not.toHaveBeenCalled();

    resolveCall({ content: [{ type: "text", text: "answered" }] });
    await expect(inFlight).resolves.toEqual({
      content: [{ type: "text", text: "answered" }],
    });
  });

  it("still kills a hung server at the base timeout when nothing is pending", async () => {
    const manager = buildManager({ elicitationTimeoutExtensionMs: 600_000 });
    manager.setElicitationCallback(() => ({ action: "cancel" } as any));

    let received: AbortSignal | undefined;
    // A server that never answers, and never elicits: this is the hang the
    // base budget exists to catch. Model the upstream contract — reject with
    // the signal's reason on abort.
    const callTool = jest.fn(
      (_params: unknown, options: any) =>
        new Promise((_resolve, reject) => {
          received = options.signal;
          options.signal.addEventListener("abort", () =>
            reject(options.signal.reason)
          );
        })
    );
    attachClient(manager, callTool);
    setPending(manager, () => false);

    const inFlight = manager.executeTool(SERVER, "add", { a: 1 });
    const caught = inFlight.catch((error) => error);

    await jest.advanceTimersByTimeAsync(2_000);
    const error = await caught;

    expect(received!.aborted).toBe(true);
    expect(error).toBeInstanceOf(SdkError);
    expect(error.code).toBe(SdkErrorCode.RequestTimeout);
    expect(error.data).toMatchObject({ reason: "server-timeout" });
  });

  it("aborts when the suspended budget is exhausted", async () => {
    const manager = buildManager({ elicitationTimeoutExtensionMs: 10_000 });
    manager.setElicitationCallback(() => ({ action: "cancel" } as any));

    const callTool = jest.fn(
      (_params: unknown, options: any) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(options.signal.reason)
          );
        })
    );
    attachClient(manager, callTool);
    setPending(manager, () => true);

    const inFlight = manager.executeTool(SERVER, "add", { a: 1 });
    const caught = inFlight.catch((error) => error);

    await jest.advanceTimersByTimeAsync(12_000);
    const error = await caught;

    expect(error).toBeInstanceOf(SdkError);
    expect(error.data).toMatchObject({ reason: "elicitation-budget" });
  });

  it("propagates a caller abort through the composed signal", async () => {
    const manager = buildManager({ elicitationTimeoutExtensionMs: 600_000 });
    manager.setElicitationCallback(() => ({ action: "cancel" } as any));

    let received: AbortSignal | undefined;
    const callTool = jest.fn((_params: unknown, options: any) => {
      received = options.signal;
      return new Promise(() => {});
    });
    attachClient(manager, callTool);
    setPending(manager, () => true);

    const caller = new AbortController();
    const inFlight = manager.executeTool(
      SERVER,
      "add",
      { a: 1 },
      {
        signal: caller.signal,
      }
    );
    const caught = inFlight.catch((error) => error);

    await jest.advanceTimersByTimeAsync(10);
    expect(received!.aborted).toBe(false);

    const reason = new Error("caller cancelled the turn");
    caller.abort(reason);
    await jest.advanceTimersByTimeAsync(10);

    // The watchdog composed with the caller's signal rather than replacing it.
    expect(received!.aborted).toBe(true);
    expect(received!.reason).toBe(reason);
    await caught;
  });

  it("disposes the watchdog once the call settles", async () => {
    const manager = buildManager({ elicitationTimeoutExtensionMs: 600_000 });
    manager.setElicitationCallback(() => ({ action: "cancel" } as any));
    attachClient(manager, jest.fn().mockResolvedValue({ content: [] }));
    setPending(manager, () => false);

    const before = jest.getTimerCount();
    await manager.executeTool(SERVER, "add", { a: 1 });
    expect(jest.getTimerCount()).toBe(before);
  });

  it("disposes the watchdog when the call throws", async () => {
    const manager = buildManager({ elicitationTimeoutExtensionMs: 600_000 });
    manager.setElicitationCallback(() => ({ action: "cancel" } as any));
    attachClient(
      manager,
      jest
        .fn()
        .mockRejectedValue(Object.assign(new Error("boom"), { code: -1 }))
    );
    setPending(manager, () => false);

    const before = jest.getTimerCount();
    await expect(manager.executeTool(SERVER, "add", { a: 1 })).rejects.toThrow(
      "boom"
    );
    expect(jest.getTimerCount()).toBe(before);
  });
});
