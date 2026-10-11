import { describe, expect, it, vi } from "vitest";
import {
  createPluginSession,
  reducePluginSession,
  pluginInstanceKey,
  pluginContextForTurn,
  createPluginSessionRunner,
  pluginWorkspaceCheckpoint,
  createPluginWorkspaceReplay,
  type PluginInstanceIdentity,
  type PluginSessionCommand,
} from "../../src/plugin-host/index.js";
import { expectNoNodeBuiltins } from "../support/node-builtin-guard.js";

const identity: PluginInstanceIdentity = {
  workspaceId: "workspace",
  scope: { kind: "thread", threadId: "thread-a" },
  pluginVersionId: "plugin-version",
  serverId: "server",
  bindingId: "binding",
  origin: { kind: "thread", id: "entrypoint" },
};
const activate: PluginSessionCommand = {
  type: "activate",
  instanceId: "instance",
  identity,
  operationId: "activation",
  target: { serverId: "server", toolName: "open", arguments: {} },
};
const opened = () =>
  reducePluginSession(createPluginSession("workspace"), activate).state;

describe("shared plugin session", () => {
  it("adopts a completed executor instance without invoking it again", () => {
    const command: PluginSessionCommand = {
      type: "attach",
      instanceId: "completed",
      identity,
      generation: 7,
      initialResult: { content: [], _meta: { opaque: true } },
    };
    const attached = reducePluginSession(
      createPluginSession("workspace"),
      command
    );
    expect(attached.effects).toEqual([]);
    expect(attached.state.operations).toEqual({});
    expect(attached.state.instances.completed.generation).toBe(7);
    expect(
      reducePluginSession(attached.state, {
        ...command,
        initialResult: "duplicate",
      }).state
    ).toBe(attached.state);
    expect(
      reducePluginSession(attached.state, { ...command, generation: 8 })
        .rejection
    ).toBe("INSTANCE_MISMATCH");
    expect(
      reducePluginSession(attached.state, { ...command, instanceId: "alias" })
        .rejection
    ).toBe("INSTANCE_EXISTS");
    const closed = reducePluginSession(attached.state, {
      type: "close",
      instanceId: "completed",
    }).state;
    expect(reducePluginSession(closed, command).rejection).toBe(
      "INSTANCE_MISMATCH"
    );
  });

  it("validates adopted ownership and preserves structured context separately", () => {
    const command: PluginSessionCommand = {
      type: "attach",
      instanceId: "completed",
      identity,
      generation: 1,
    };
    expect(
      reducePluginSession(createPluginSession("other"), command).rejection
    ).toBe("WORKSPACE_MISMATCH");
    expect(
      reducePluginSession(createPluginSession("workspace"), {
        ...command,
        generation: 0,
      }).rejection
    ).toBe("INVALID_ID");
    const state = reducePluginSession(
      createPluginSession("workspace"),
      command
    ).state;
    const structuredContent = { selection: [1, 2] };
    const updated = reducePluginSession(state, {
      type: "context",
      instanceId: "completed",
      generation: 1,
      updateId: "context",
      content: [],
      structuredContent,
    }).state;
    structuredContent.selection.push(3);
    expect(
      pluginContextForTurn(updated, "thread-a")[0].structuredContent
    ).toEqual({ selection: [1, 2] });
    expect(pluginContextForTurn(updated, "thread-b")).toEqual([]);
  });
  it("releases only revoked adopted leases, preserving any invocation receipt references", () => {
    const adopted = reducePluginSession(createPluginSession("workspace"), {
      type: "attach",
      instanceId: "adopted",
      generation: 1,
      identity,
    }).state;
    expect(
      reducePluginSession(adopted, {
        type: "release-closed",
        instanceId: "adopted",
        generation: 1,
      }).rejection
    ).toBe("STALE_INSTANCE");
    const closed = reducePluginSession(adopted, {
      type: "close",
      instanceId: "adopted",
    }).state;
    expect(
      reducePluginSession(closed, {
        type: "release-closed",
        instanceId: "adopted",
        generation: 1,
      }).rejection
    ).toBe("STALE_INSTANCE");
    const released = reducePluginSession(closed, {
      type: "release-closed",
      instanceId: "adopted",
      generation: 2,
    });
    expect(released.state.instances).toEqual({});
    expect(released.effects).toEqual([]);
    const withOperation = reducePluginSession(opened(), {
      type: "close",
      instanceId: "instance",
    }).state;
    expect(
      reducePluginSession(withOperation, {
        type: "release-closed",
        instanceId: "instance",
        generation: 2,
      }).rejection
    ).toBe("INSTANCE_OPERATION_REFERENCES");
  });
  it("includes scope, version, server, target and origin in unambiguous identity", () => {
    for (const key of [
      "workspaceId",
      "pluginVersionId",
      "serverId",
      "bindingId",
    ] as const)
      expect(pluginInstanceKey({ ...identity, [key]: "different" })).not.toBe(
        pluginInstanceKey(identity)
      );
    expect(
      pluginInstanceKey({
        ...identity,
        scope: { kind: "thread", threadId: "thread-b" },
      })
    ).not.toBe(pluginInstanceKey(identity));
    expect(
      pluginInstanceKey({
        ...identity,
        origin: { kind: "settings", id: "entrypoint" },
      })
    ).not.toBe(pluginInstanceKey(identity));
    expect(() =>
      pluginInstanceKey({ ...identity, origin: { kind: "file", id: "file" } })
    ).toThrow();
  });

  it("accepts each operation once and preserves the activation result envelope", () => {
    const first = reducePluginSession(
      createPluginSession("workspace"),
      activate
    );
    expect(first.effects).toHaveLength(1);
    expect(reducePluginSession(first.state, activate).effects).toEqual([]);
    const result = {
      content: [{ type: "text", text: "Full result" }],
      structuredContent: { ready: true },
      _meta: { opaque: true },
    };
    const complete = reducePluginSession(first.state, {
      type: "completed",
      operationId: "activation",
      generation: 1,
      result,
    });
    expect(complete.state.instances.instance.initialResult).toEqual(result);
    expect(
      reducePluginSession(complete.state, {
        type: "completed",
        operationId: "activation",
        generation: 1,
        result: "late",
      }).state
    ).toBe(complete.state);
    result.structuredContent.ready = false;
    expect(complete.state.instances.instance.initialResult).not.toEqual(result);
  });

  it("hides without cancelling; context stays confined to its thread", () => {
    let state = reducePluginSession(opened(), {
      type: "context",
      instanceId: "instance",
      generation: 1,
      updateId: "update",
      content: [{ type: "text", text: "selection" }],
    }).state;
    const hide = reducePluginSession(state, {
      type: "presentation",
      instanceId: "instance",
      visible: false,
    });
    expect(hide.effects).toEqual([]);
    state = hide.state;
    expect(state.instances.instance.generation).toBe(1);
    expect(pluginContextForTurn(state, "thread-a")).toHaveLength(1);
    expect(pluginContextForTurn(state, "thread-b")).toEqual([]);
  });

  it("fences replacements and distinguishes cancellation from uncertain dispatched outcomes", () => {
    const queued = opened();
    const running = reducePluginSession(queued, {
      type: "dispatched",
      operationId: "activation",
      generation: 1,
    }).state;
    expect(
      reducePluginSession(queued, { type: "close", instanceId: "instance" })
        .state.operations.activation.phase
    ).toBe("cancelled");
    const replaced = reducePluginSession(running, {
      type: "replace",
      instanceId: "instance",
    });
    expect(replaced.state.operations.activation.phase).toBe("unknown");
    expect(replaced.effects).toEqual([
      { type: "cancel", operationId: "activation" },
      { type: "release", instanceId: "instance", generation: 1 },
    ]);
    expect(
      reducePluginSession(replaced.state, {
        type: "completed",
        operationId: "activation",
        generation: 1,
        result: "stale",
      }).state
    ).toBe(replaced.state);
    expect(
      reducePluginSession(replaced.state, {
        type: "context",
        instanceId: "instance",
        generation: 1,
        updateId: "stale",
        content: [],
      }).rejection
    ).toBe("STALE_INSTANCE");
  });

  it("rejects crossed authority and bounded workspace exhaustion without evicting deduplication", () => {
    const state = opened();
    expect(
      reducePluginSession(state, {
        ...activate,
        operationId: "other",
        instanceId: "other",
      }).rejection
    ).toBe("INSTANCE_EXISTS");
    expect(
      reducePluginSession(state, {
        ...activate,
        operationId: "other",
        target: { ...activate.target, serverId: "foreign" },
      }).rejection
    ).toBe("TARGET_MISMATCH");
    expect(
      reducePluginSession(createPluginSession("other"), activate).rejection
    ).toBe("WORKSPACE_MISMATCH");
    const bounded = reducePluginSession(
      createPluginSession("workspace", { instances: 1, operations: 1 }),
      activate
    ).state;
    expect(
      reducePluginSession(bounded, { ...activate, operationId: "next" })
        .rejection
    ).toBe("OPERATION_LIMIT");
    expect(reducePluginSession(bounded, activate).effects).toEqual([]);
  });

  it("treats hostile object keys as data instead of prototypes", () => {
    const transition = reducePluginSession(createPluginSession("workspace"), {
      ...activate,
      instanceId: "__proto__",
      operationId: "constructor",
    });
    expect(Object.getPrototypeOf(transition.state.instances)).toBeNull();
    expect(Object.hasOwn(transition.state.instances, "__proto__")).toBe(true);
    expect(transition.effects).toHaveLength(1);
  });

  it("never invokes a queued effect closed by a synchronous subscriber", async () => {
    const invoke = vi.fn(async () => "result");
    const runner = createPluginSessionRunner(createPluginSession("workspace"), {
      invoke,
      release: vi.fn(),
      classifyError: () => ({ errorCode: "CANCELLED" }),
    });
    runner.subscribe(() => {
      if (runner.getSnapshot().instances.instance?.lifecycle === "active")
        runner.dispatch({ type: "close", instanceId: "instance" });
    });
    runner.dispatch(activate);
    await new Promise((resolve) => setImmediate(resolve));
    expect(invoke).not.toHaveBeenCalled();
    expect(runner.getSnapshot().operations.activation.phase).toBe("cancelled");
    runner.dispose();
  });

  it("cancels a live operation and ignores its late completion", async () => {
    let finish!: (result: unknown) => void;
    let signal!: AbortSignal;
    const release = vi.fn();
    const runner = createPluginSessionRunner(createPluginSession("workspace"), {
      invoke: async (_effect, ctx) => {
        signal = ctx.signal;
        ctx.dispatched();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      release,
      classifyError: () => ({ errorCode: "FAILED" }),
    });
    runner.dispatch(activate);
    await vi.waitFor(() => expect(finish).toBeDefined());
    runner.dispose();
    expect(signal.aborted).toBe(true);
    finish("late");
    await new Promise((resolve) => setImmediate(resolve));
    expect(runner.getSnapshot().operations.activation.phase).toBe("unknown");
    expect(release).toHaveBeenCalledWith("instance", 1);
    expect(runner.dispatch(activate).rejection).toBe("SESSION_CLOSED");
  });

  it("projects replay without private payloads or any execution methods", () => {
    let state = reducePluginSession(opened(), {
      type: "context",
      instanceId: "instance",
      generation: 1,
      updateId: "context",
      content: [{ text: "private context" }],
      metadata: { apiKey: "secret" },
    }).state;
    state = reducePluginSession(state, {
      type: "completed",
      operationId: "activation",
      generation: 1,
      result: { privatePath: "/private/file", credential: "secret" },
    }).state;
    const checkpoint = pluginWorkspaceCheckpoint(state);
    expect(JSON.stringify(checkpoint)).not.toMatch(/secret|private/);
    const replay = createPluginWorkspaceReplay(checkpoint);
    expect(Object.keys(replay)).toEqual(["getSnapshot"]);
    checkpoint.instances[0].generation = 99;
    expect(replay.getSnapshot().instances[0].generation).toBe(1);
  });

  it("bundles the shared entry with no Node builtins", async () => {
    await expectNoNodeBuiltins(
      new URL("../../src/plugin-host/index.ts", import.meta.url)
    );
  });

  it("fails explicitly on future replay versions and corrupt ownership", () => {
    const checkpoint = pluginWorkspaceCheckpoint(opened());
    expect(() =>
      createPluginWorkspaceReplay({ ...checkpoint, version: 2 })
    ).toThrow();
    expect(() =>
      createPluginWorkspaceReplay({
        ...checkpoint,
        operations: [{ ...checkpoint.operations[0], instanceId: "unowned" }],
      })
    ).toThrow();
    expect(() =>
      createPluginWorkspaceReplay({
        ...checkpoint,
        instances: [checkpoint.instances[0], checkpoint.instances[0]],
      })
    ).toThrow();
    expect(() =>
      createPluginWorkspaceReplay({ ...checkpoint, privatePayload: "secret" })
    ).toThrow();
  });

  it("reports observer, malformed completion and cleanup failures without losing teardown", async () => {
    const onError = vi.fn();
    const release = vi.fn(() => {
      throw new Error("Adapter cleanup failed");
    });
    const runner = createPluginSessionRunner(createPluginSession("workspace"), {
      invoke: async (_effect, ctx) => {
        ctx.dispatched();
        return () => "not a wire value";
      },
      release,
      onError,
      classifyError: () => {
        throw new Error("Classifier failed");
      },
    });
    runner.subscribe(() => {
      throw new Error("Observer failed");
    });
    runner.dispatch(activate);
    await vi.waitFor(() =>
      expect(runner.getSnapshot().operations.activation.phase).toBe("unknown")
    );
    runner.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining(["observer", "completion", "release"])
    );
  });
});
