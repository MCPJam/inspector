import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  execute: vi.fn(),
  resolve: vi.fn(),
  release: vi.fn(),
}));
vi.mock("../receipt-store.js", () => ({
  createPluginInvocationReceiptPort: () => undefined,
  pluginInvocationOwnerHash: () => "hash",
}));
vi.mock("../request-runtime.js", () => ({
  createPluginRequestRuntime: () => ({
    resolve: state.resolve,
    runOwnedLegacy: state.execute,
    handleLegacyForm: async () => ({ action: "accept" }),
    release: state.release,
  }),
}));
import {
  createModelFormDispatch,
  createModelFormExecutor,
} from "../model-forms.js";
import { pluginInstances } from "../instances.js";
const identity = {
  actorId: "actor",
  projectId: "project",
  workspaceId: "workspace",
  subject: "subject",
};
function fixture() {
  const abort = new AbortController();
  const admission = { ...identity, revalidate: vi.fn(async () => {}) };
  const execute = createModelFormExecutor({
    c: { req: { raw: { signal: abort.signal } } } as any,
    admission,
    identity,
    bearer: "fixture",
    hostId: "host",
    hostRevision: "host-revision",
    serverIds: ["server"],
    eligibleServerIds: ["server"],
    dispatch: createModelFormDispatch(["server"]),
  });
  const input = {
    serverKey: "server",
    toolName: "review",
    toolCallId: "original-call",
    input: { zero: 0 },
  };
  return { execute, input, abort, admission };
}
beforeEach(() => {
  state.resolve.mockReset().mockResolvedValue({
    revision: "revision",
    hostRevision: "host-revision",
    bindingId: "binding",
    serverIdentity: { kind: "standalone", serverId: "server" },
    tool: { name: "review" },
    requiresApproval: true,
  });
  state.release.mockReset().mockResolvedValue(undefined);
  state.execute
    .mockReset()
    .mockImplementation(async (auth, _id, _signal, run) => {
      expect(pluginInstances.getFormOwner(auth.owner, identity).hostId).toBe(
        "host",
      );
      return run();
    });
});
describe("owned model legacy forms", () => {
  it("uses the actual model operation and releases its source owner", async () => {
    const f = fixture();
    const original = vi.fn(async () => ({
      content: [{ type: "text", text: "answered" }],
    }));
    expect(await f.execute(f.input, original)).toEqual({
      content: [{ type: "text", text: "answered" }],
    });
    expect(original).toHaveBeenCalledTimes(1);
    const [auth, id] = state.execute.mock.calls[0];
    expect(auth.origin).toBe("model");
    expect(id).toBe("original-call");
    expect(auth.owner).not.toHaveProperty("subject");
    expect(() => pluginInstances.getFormOwner(auth.owner, identity)).toThrow();
    expect(state.release).toHaveBeenCalledTimes(2);
  });
  it("preserves the existing executor for unqualified connection profiles", async () => {
    const f = fixture();
    const original = vi.fn(async () => "ordinary");
    expect(await f.execute({ ...f.input, serverKey: "modern" }, original)).toBe(
      "ordinary",
    );
    expect(state.resolve).not.toHaveBeenCalled();
  });
  it("refuses missing engine call identity before a tool executes", async () => {
    const f = fixture();
    await expect(
      f.execute({ ...f.input, toolCallId: "" }, vi.fn()),
    ).rejects.toThrow();
    expect(state.execute).not.toHaveBeenCalled();
  });
  it("refuses changed target revision before execution", async () => {
    const f = fixture();
    const initial = await state.resolve();
    state.resolve
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue({ ...initial, revision: "changed" });
    await expect(f.execute(f.input, vi.fn())).rejects.toThrow();
    expect(state.execute).not.toHaveBeenCalled();
  });
  it("does not recover a model owner across a different credential", async () => {
    state.execute.mockImplementation(async (auth) => {
      expect(() =>
        pluginInstances.getFormOwner(auth.owner, {
          ...identity,
          subject: "other",
        }),
      ).toThrow();
      return { content: [] };
    });
    const f = fixture();
    await f.execute(f.input, vi.fn());
  });
});

it("refuses a host revision that changed after the normal model approval gate", async () => {
  state.resolve.mockResolvedValue({
    revision: "revision",
    hostRevision: "changed",
    bindingId: "binding",
    serverIdentity: { kind: "standalone", serverId: "server" },
    tool: { name: "review" },
  });
  const f = fixture();
  await expect(f.execute(f.input, vi.fn())).rejects.toThrow();
  expect(state.execute).not.toHaveBeenCalled();
});

describe("model form request dispatch", () => {
  it("rejects unsolicited forms outside an original tool call", async () => {
    const d = createModelFormDispatch(["server"]);
    expect(() =>
      d.handlers.server[0].handler({ params: {} } as never),
    ).toThrow();
  });
  it("serializes same-server calls and binds forms to the current original call", async () => {
    const d = createModelFormDispatch(["server"]);
    const signal = new AbortController().signal;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = d.run(
      "server",
      async () => "first",
      signal,
      async () => {
        expect(
          await d.handlers.server[0].handler({ params: {} } as never),
        ).toBe("first");
        await wait;
        return "done";
      },
    );
    let secondRan = false;
    const second = d.run(
      "server",
      async () => "second",
      signal,
      async () => {
        secondRan = true;
        return d.handlers.server[0].handler({ params: {} } as never);
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(secondRan).toBe(false);
    release();
    expect(await first).toBe("done");
    expect(await second).toBe("second");
    expect(() =>
      d.handlers.server[0].handler({ params: {} } as never),
    ).toThrow();
  });
  it("a cancelled queued call cannot let its successor overtake the active call", async () => {
    const d = createModelFormDispatch(["server"]);
    const signal = new AbortController().signal;
    let release!: () => void;
    const first = d.run(
      "server",
      async () => "first",
      signal,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    await Promise.resolve();
    const abort = new AbortController();
    const second = d.run(
      "server",
      async () => "second",
      abort.signal,
      async () => "bad",
    );
    abort.abort();
    await expect(second).rejects.toThrow();
    let thirdRan = false;
    const third = d.run(
      "server",
      async () => "third",
      signal,
      async () => {
        thirdRan = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(thirdRan).toBe(false);
    release();
    await first;
    await third;
    expect(thirdRan).toBe(true);
  });
});
