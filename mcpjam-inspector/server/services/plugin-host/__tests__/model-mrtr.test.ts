import { describe, it, expect, vi, beforeEach } from "vitest";
const state = vi.hoisted(() => ({
  run: vi.fn(),
  resume: vi.fn(),
  resolve: vi.fn(),
  release: vi.fn(),
  assertSchema: vi.fn(),
}));
vi.mock("../receipt-store.js", () => ({
  createPluginInvocationReceiptPort: () => undefined,
  pluginInvocationOwnerHash: () => "hash",
}));
vi.mock("../request-runtime.js", () => ({
  createPluginRequestRuntime: () => ({
    resolve: state.resolve,
    runOwnedModern: state.run,
    resumeMrtr: state.resume,
    collectOwnedMrtr: vi.fn(),
    release: state.release,
    manager: () => ({ assertMrtrToolOutputSchema: state.assertSchema }),
  }),
}));
import { createModelMrtrAdapter } from "../model-mrtr.js";
import { PluginInvocationSuspension } from "../invocation.js";
import { pluginInstances } from "../instances.js";
const identity = {
  actorId: "actor",
  projectId: "project",
  workspaceId: "workspace",
  subject: "subject",
};
const pending = () =>
  new PluginInvocationSuspension({
    continuationId: crypto.randomUUID(),
    round: 1,
    status: "input_required",
    version: 1,
    serverId: "server",
    method: "tools/call",
    inputRequests: [],
    expiresAt: Date.now() + 100000,
  });
function fixture(overrides = {}) {
  const abort = new AbortController();
  const options = {
    c: { req: { raw: { signal: abort.signal } } } as any,
    admission: { ...identity, revalidate: vi.fn(async () => {}) },
    identity,
    bearer: "fixture",
    hostId: "host",
    hostRevision: "host-revision",
    serverIds: ["server"],
    ...overrides,
  };
  const adapter = createModelMrtrAdapter(options);
  const write = vi.fn();
  adapter.attachStreamWriter({ write });
  const execution = {
    serverKey: "server",
    toolName: "review",
    toolCallId: crypto.randomUUID(),
    input: { count: 0 },
  };
  return { adapter, write, execution, options, abort };
}
beforeEach(() => {
  state.resolve.mockReset().mockResolvedValue({
    revision: "revision",
    hostRevision: "host-revision",
    bindingId: "binding",
    serverIdentity: { kind: "standalone", serverId: "server" },
    tool: { name: "review" },
  });
  state.run.mockReset().mockImplementation(async (auth) => {
    expect(pluginInstances.getFormOwner(auth.owner, identity)).toBeTruthy();
    return pending();
  });
  state.resume
    .mockReset()
    .mockResolvedValue({ content: [{ type: "text", text: "done" }] });
  state.release.mockReset().mockResolvedValue(undefined);
  state.assertSchema.mockReset().mockResolvedValue(undefined);
});
describe("original model MRTR owner", () => {
  it("suspends without holding the worker, resumes on the same receipt, and retries delivery without another leg", async () => {
    const f = fixture();
    await expect(f.adapter.execute(f.execution, vi.fn())).rejects.toMatchObject(
      { code: "MRTR_SUSPENDED" },
    );
    const event = f.write.mock.calls[0][0].data;
    expect(event.pluginModelOperation.toolCallId).toBe(f.execution.toolCallId);
    expect(event.pluginFormServiceScope).toEqual({
      projectId: "project",
      workspaceId: "workspace",
    });
    const next = createModelMrtrAdapter(f.options);
    next.attachStreamWriter({ write: f.write });
    const submission = {
      continuationId: event.continuationId,
      round: 1,
      responsesBlobId: "private",
    };
    expect(
      await next.resume(event.pluginModelOperation, submission, "server"),
    ).toMatchObject({ kind: "complete" });
    expect(
      await next.resume(event.pluginModelOperation, submission, "server"),
    ).toMatchObject({ kind: "complete" });
    expect(state.run).toHaveBeenCalledTimes(1);
    expect(state.resume).toHaveBeenCalledTimes(1);
    expect(state.assertSchema).toHaveBeenCalled();
  });
  it("refuses a foreign credential and changed original operation", async () => {
    const f = fixture();
    await expect(f.adapter.execute(f.execution, vi.fn())).rejects.toMatchObject(
      { code: "MRTR_SUSPENDED" },
    );
    const event = f.write.mock.calls[0][0].data;
    const submission = {
      continuationId: event.continuationId,
      round: 1,
      responsesBlobId: "private",
    };
    const foreign = createModelMrtrAdapter({
      ...f.options,
      identity: { ...identity, subject: "other" },
    });
    await expect(
      foreign.resume(event.pluginModelOperation, submission, "server"),
    ).rejects.toThrow();
    await expect(
      f.adapter.resume(
        { ...event.pluginModelOperation, toolCallId: "other" },
        submission,
        "server",
      ),
    ).rejects.toThrow();
    expect(state.resume).not.toHaveBeenCalled();
  });
  it("keeps source ownership across the first request ending", async () => {
    const f = fixture();
    await expect(f.adapter.execute(f.execution, vi.fn())).rejects.toMatchObject(
      { code: "MRTR_SUSPENDED" },
    );
    const owner = state.run.mock.calls[0][0].owner;
    f.abort.abort();
    expect(pluginInstances.getFormOwner(owner, identity)).toBeTruthy();
  });
  it("refuses unsolicited modern input before dispatch", async () => {
    const f = fixture();
    expect(() =>
      f.adapter.collectorForServer("server")!({} as never),
    ).toThrow();
  });
  it("replays a lost resuspension response without driving the first leg twice", async () => {
    const f = fixture();
    await expect(f.adapter.execute(f.execution, vi.fn())).rejects.toMatchObject(
      { code: "MRTR_SUSPENDED" },
    );
    const first = f.write.mock.calls[0][0].data;
    state.resume.mockResolvedValueOnce(
      new PluginInvocationSuspension({ ...first, round: 2 }),
    );
    const submission = {
      continuationId: first.continuationId,
      round: 1,
      responsesBlobId: "private-first",
    };
    expect(
      await f.adapter.resume(first.pluginModelOperation, submission, "server"),
    ).toMatchObject({ kind: "suspended", round: 2 });
    expect(
      await f.adapter.resume(first.pluginModelOperation, submission, "server"),
    ).toMatchObject({ kind: "suspended", round: 2 });
    expect(state.resume).toHaveBeenCalledTimes(1);
  });
  it("treats invalid completed output as a recoverable result without retrying the wire", async () => {
    const f = fixture();
    await expect(f.adapter.execute(f.execution, vi.fn())).rejects.toMatchObject(
      { code: "MRTR_SUSPENDED" },
    );
    const first = f.write.mock.calls[0][0].data;
    state.assertSchema.mockRejectedValue(new Error("invalid"));
    expect(
      await f.adapter.resume(
        first.pluginModelOperation,
        {
          continuationId: first.continuationId,
          round: 1,
          responsesBlobId: "private",
        },
        "server",
      ),
    ).toMatchObject({ kind: "recover" });
    expect(state.resume).toHaveBeenCalledTimes(1);
    expect(f.write.mock.calls.at(-1)![0].data.kind).toBe("resolved");
  });
  it("refuses replay with changed arguments under the same engine id", async () => {
    const f = fixture();
    await expect(f.adapter.execute(f.execution, vi.fn())).rejects.toMatchObject(
      { code: "MRTR_SUSPENDED" },
    );
    await expect(
      f.adapter.execute({ ...f.execution, input: { count: 9 } }, vi.fn()),
    ).rejects.toThrow();
    expect(state.run).toHaveBeenCalledTimes(1);
  });
  it("refuses a changed host snapshot before original model dispatch", async () => {
    const f = fixture({ hostRevision: "changed-after-approval" });
    await expect(f.adapter.execute(f.execution, vi.fn())).rejects.toThrow();
    expect(state.run).not.toHaveBeenCalled();
  });
});
