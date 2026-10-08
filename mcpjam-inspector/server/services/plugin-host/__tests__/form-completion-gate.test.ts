import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Completion gate for plugin forms on both wires (Phase 4): legacy direct
 * `openai/elicitation/create` and modern MRTR, each with several rounds,
 * accept / decline / cancel, request expiry and a reconnect mid-form.
 */
const seams = vi.hoisted(() => ({
  callback: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("../../../routes/web/hosted-elicitation.js", () => ({
  HostedElicitationBridge: class {
    callback = seams.callback;
    dispose = vi.fn();
    attachStreamWriter() {}
  },
}));
vi.mock("../../../utils/mrtr-hosted-collector.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/mrtr-hosted-collector.js")
  >()),
  resumeMrtrContinuationLeg: seams.resume,
}));
vi.mock("../../../utils/mrtr-continuation-state.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/mrtr-continuation-state.js")
  >()),
  cancelContinuation: seams.cancel,
}));
import { createOwnedPluginLegacyForms } from "../owned-legacy.js";
import { createOwnedPluginMrtr } from "../owned-mrtr.js";
import { pluginFormSources } from "../form-sources.js";
import { RequestOwnedToolInvoker } from "../request-invoker.js";
import {
  PluginInvocationSuspension,
  type PluginInvocationPorts,
  type ResolvedInvocationContext,
} from "../invocation.js";

const schema = (name: string) => ({
  type: "object",
  required: [name],
  properties: { [name]: { type: "string" } },
});
const legacyRequest = (name: string) => ({
  params: { mode: "form", message: `Choose ${name}`, requestedSchema: schema(name) },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("legacy openai/elicitation/create gate", () => {
  function legacy() {
    const forms = createOwnedPluginLegacyForms({
      bearer: "fixture",
      projectId: "project",
      workspaceId: "workspace",
      hostId: "host",
      hostRevision: "revision",
      serverId: "server",
      signal: new AbortController().signal,
      manager: () =>
        ({
          getInitializationInfo: () => ({ protocolVersion: "2025-11-25" }),
        }) as never,
      assertCurrent: async () => {},
      profile: {
        fileResources: true,
        origin: "server",
        userResources: false,
        previews: false,
      },
    });
    const authorization = { origin: "app" } as ResolvedInvocationContext;
    return {
      forms,
      run: <T>(execute: () => Promise<T>, signal = new AbortController().signal) =>
        forms.run(authorization, "operation", signal, execute),
    };
  }
  beforeEach(() => seams.callback.mockReset());

  it("answers several rounds inside one tool call", async () => {
    seams.callback
      .mockResolvedValueOnce({ action: "accept", content: { part: "bolt" } })
      .mockResolvedValueOnce({ action: "accept", content: { size: "M4" } })
      .mockResolvedValueOnce({ action: "decline" });
    const f = legacy();
    const answers = await f.run(async () => [
      await f.forms.binding.handler(legacyRequest("part")),
      await f.forms.binding.handler(legacyRequest("size")),
      await f.forms.binding.handler(legacyRequest("finish")),
    ]);
    expect(answers).toEqual([
      { action: "accept", content: { part: "bolt" } },
      { action: "accept", content: { size: "M4" } },
      { action: "decline" },
    ]);
    expect(seams.callback).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ action: "accept", content: { part: "nut" } }],
    [{ action: "decline" }],
    [{ action: "cancel" }],
  ])("delivers %j unchanged", async (answer) => {
    seams.callback.mockResolvedValueOnce(answer);
    const f = legacy();
    await expect(
      f.run(() => f.forms.binding.handler(legacyRequest("part"))),
    ).resolves.toEqual(answer);
  });

  it("fails an expired request and still serves the next round", async () => {
    seams.callback
      .mockRejectedValueOnce(new Error("Form request expired"))
      .mockResolvedValueOnce({ action: "accept", content: { part: "nut" } });
    const f = legacy();
    const outcome = await f.run(async () => {
      const expired = await f.forms.binding
        .handler(legacyRequest("part"))
        .catch((error: Error) => error.message);
      const next = await f.forms.binding.handler(legacyRequest("part"));
      return { expired, next };
    });
    expect(outcome).toEqual({
      expired: "Form request expired",
      next: { action: "accept", content: { part: "nut" } },
    });
  });

  it("never delivers a pending answer into the call that follows a reconnect", async () => {
    const pending = deferred<unknown>();
    seams.callback.mockReturnValueOnce(pending.promise);
    const f = legacy();
    const dropped = new AbortController();
    let late: Promise<unknown> | undefined;
    const first = f.run(async () => {
      late = f.forms.binding.handler(legacyRequest("part"));
      void late.catch(() => {});
      // The connection drops mid-form; the tool call ends with it.
      await new Promise((_, reject) =>
        dropped.signal.addEventListener("abort", () =>
          reject(new Error("connection closed")),
        ),
      );
    }, dropped.signal);
    await vi.waitFor(() => expect(seams.callback).toHaveBeenCalledOnce());
    dropped.abort();
    await expect(first).rejects.toThrow("connection closed");
    // After reconnecting, the server re-runs the tool and asks again.
    seams.callback.mockResolvedValueOnce({
      action: "accept",
      content: { part: "washer" },
    });
    const second = f.run(() => f.forms.binding.handler(legacyRequest("part")));
    pending.resolve({ action: "accept", content: { part: "stale" } });
    await expect(late).rejects.toThrow();
    await expect(second).resolves.toEqual({
      action: "accept",
      content: { part: "washer" },
    });
  });
});

describe("modern MRTR gate", () => {
  const owner = {
    actorId: "actor",
    projectId: "project",
    workspaceId: "workspace",
    instanceId: "instance",
    generation: 1,
    serverId: "server",
    bindingId: "binding",
    placement: "interactive" as const,
  };
  const authorization: ResolvedInvocationContext = {
    owner,
    origin: "app",
    revision: "revision",
    tool: { name: "tool" },
    enabled: true,
    requiresApproval: false,
    allowedOrigins: ["app"],
  };
  const manager = (connected = true) =>
    ({
      getManagedClient: () => (connected ? {} : undefined),
      getInitializationInfo: () => ({ protocolVersion: "2026-07-28" }),
      getServerConfig: () => ({ url: "https://disposable.invalid" }),
    }) as never;
  const service = (current = manager()) =>
    createOwnedPluginMrtr({
      c: {} as never,
      bearer: "disposable",
      projectId: "project",
      serverId: "server",
      sourceBinding: { hostId: "host", hostRevision: "host-revision" },
      assertCurrent: async () => {},
      manager: () => current,
    });
  const display = (key: string) => ({
    key,
    mode: "form",
    message: `Choose ${key}`,
    requestedSchema: schema(key),
  });
  const bindRound = (round: number, key: string) =>
    pluginFormSources.bind({
      owner,
      hostId: "host",
      hostRevision: "host-revision",
      invocationId: "operation",
      origin: "app",
      revision: "revision",
      toolName: "tool",
      parent: { kind: "mrtr", id: "continuation", round, inputRequestKey: key },
      requestedSchema: schema(key),
      expiresAt: Date.now() + 60_000,
    });
  const answer = (round: number, key: string, response: unknown) =>
    seams.resume.mockImplementationOnce(async (options) => {
      const prepared = await options.prepareLeg(
        {
          method: "tools/call",
          originalParams: { name: "tool" },
          pendingInputRequests: {
            [key]: {
              method: "elicitation/create",
              params: { mode: "form", message: "Choose", requestedSchema: schema(key) },
            },
          },
        },
        { [key]: response },
      );
      prepared.commit();
      return round === 1
        ? {
            outcome: "input_required",
            round: 2,
            expiresAt: Date.now() + 60_000,
            displays: [display("size")],
          }
        : { outcome: "completed", result: { content: [{ type: "text", text: "done" }] } };
    });
  const resume = (round: number, current = manager()) =>
    service(current).resume(
      authorization,
      "operation",
      { name: "tool" },
      { continuationId: "continuation", round, responsesBlobId: `r${round}` },
      new AbortController().signal,
    );
  afterEach(() => {
    seams.resume.mockReset();
    pluginFormSources.closeOperation(owner, "operation");
  });

  it("drives two rounds to completion on fresh connections each time", async () => {
    bindRound(1, "part");
    answer(1, "part", { action: "accept", content: { part: "bolt" } });
    const second = await resume(1);
    expect(second).toBeInstanceOf(PluginInvocationSuspension);
    expect((second as PluginInvocationSuspension).pending.round).toBe(2);
    // A reconnect between rounds: the next leg runs on a new connection.
    answer(2, "size", { action: "accept", content: { size: "M4" } });
    await expect(resume(2, manager())).resolves.toEqual({
      content: [{ type: "text", text: "done" }],
    });
  });

  it.each([
    [{ action: "accept", content: { size: "M5" } }],
    [{ action: "decline" }],
    [{ action: "cancel" }],
  ])("delivers %j to the server", async (response) => {
    bindRound(2, "size");
    answer(2, "size", response);
    await expect(resume(2)).resolves.toEqual({
      content: [{ type: "text", text: "done" }],
    });
  });

  it("refuses an accept that does not satisfy the schema before the wire", async () => {
    bindRound(2, "size");
    answer(2, "size", { action: "accept", content: { size: 4 } });
    await expect(resume(2)).rejects.toThrow("CONTINUATION_FORM_UNSUPPORTED");
  });

  it("reports an expired form as a known outcome, not an uncertain effect", async () => {
    seams.resume.mockResolvedValueOnce({
      outcome: "expired",
      reason: "continuation expired",
    });
    await expect(resume(1)).rejects.toMatchObject({
      code: "CONTINUATION_EXPIRED",
      outcomeUnknown: false,
    });
  });

  it("keeps the answer retryable when the server is disconnected mid-form", async () => {
    await expect(resume(1, manager(false))).rejects.toMatchObject({
      code: "CONTINUATION_CONNECTION_UNAVAILABLE",
    });
    expect(seams.resume).not.toHaveBeenCalled();
  });

  it("lets the invoker retry the same round after a reconnect and record expiry as final", async () => {
    const suspension = (round: number) =>
      new PluginInvocationSuspension({
        continuationId: "continuation",
        round,
        status: "input_required",
      });
    const ports: PluginInvocationPorts = {
      authorize: vi.fn(async () => authorization),
      approve: vi.fn(async () => true),
      admit: vi.fn(async () => {}),
      execute: vi.fn(async () => suspension(1)),
      classifyFailure: () => "unknown",
    };
    const invoker = new RequestOwnedToolInvoker(owner, () => {});
    const params = { name: "tool" };
    await invoker.invoke(ports, "app", "operation", params);
    const resumeWith = (current: ReturnType<typeof manager>, receipt: string) => ({
      ...ports,
      continuation: {
        submission: { continuationId: "continuation", round: 1, responsesBlobId: receipt },
        resume: (
          auth: ResolvedInvocationContext,
          next: typeof params,
          signal: AbortSignal,
        ) =>
          service(current).resume(
            auth,
            "operation",
            next,
            { continuationId: "continuation", round: 1, responsesBlobId: receipt },
            signal,
          ),
      },
    });
    await expect(
      invoker.invoke(resumeWith(manager(false), "r1"), "app", "operation", params),
    ).rejects.toMatchObject({ code: "CONTINUATION_CONNECTION_UNAVAILABLE" });
    seams.resume.mockResolvedValueOnce({
      outcome: "expired",
      reason: "continuation expired",
    });
    await expect(
      invoker.invoke(resumeWith(manager(), "r1-retry"), "app", "operation", params),
    ).rejects.toMatchObject({
      code: "CONTINUATION_EXPIRED",
      outcomeUnknown: false,
    });
  });
});
