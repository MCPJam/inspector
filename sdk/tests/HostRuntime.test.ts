import { describe, it, expect, vi } from "vitest";

// Mock the dynamic `HostRunner` import that lives inside
// `HostRuntime.run()` (`await import("../HostRunner.js")`). Vitest
// intercepts at the resolved-module level, so the relative path from
// this test file is the same key — both resolve to
// `sdk/src/HostRunner.ts`.
const lastRunnerArgs: any = { config: undefined };
const runnerRunSpy = vi.fn();

vi.mock("../src/HostRunner.js", () => {
  class FakeHostRunner {
    constructor(config: unknown) {
      lastRunnerArgs.config = config;
    }
    async run(input: string, options?: unknown) {
      runnerRunSpy(input, options);
      return {
        kind: "fake-prompt-result",
        prompt: input,
        getPrompt: () => input,
      };
    }
  }
  return { HostRunner: FakeHostRunner };
});

import { Host } from "../src/host-config/host.js";
import { HostRuntime } from "../src/host-config/host-runtime.js";
import type {
  HostRuntimeManager,
  HostRuntimeDefaults,
} from "../src/host-config/host-runtime.js";

function fakeManager(
  serverIds: string[],
  toolsByServer: Record<string, Record<string, unknown>> = {},
): HostRuntimeManager & {
  getToolsForAiSdkSpy: ReturnType<typeof vi.fn>;
} {
  const known = new Set(serverIds);
  const getToolsForAiSdkSpy = vi.fn(async (ids?: string[] | string) => {
    const want = Array.isArray(ids) ? ids : ids ? [ids] : serverIds;
    const out: Record<string, unknown> = {};
    for (const id of want) {
      Object.assign(out, toolsByServer[id] ?? {});
    }
    return out;
  });
  return {
    hasServer: (id) => known.has(id),
    listServers: () => Array.from(known),
    getToolsForAiSdk: getToolsForAiSdkSpy,
    getToolsForAiSdkSpy,
  };
}

const baseDefaults: HostRuntimeDefaults = { apiKey: "test-key" };

describe("HostRuntime construction + binding", () => {
  it("host.withManager returns a HostRuntime bound to this host", () => {
    const host = new Host({
      style: "mcpjam",
      model: "openai/gpt-4o",
    }).requireServer("everything");
    const manager = fakeManager(["everything"]);

    const runtime = host.withManager(manager, baseDefaults);

    expect(runtime).toBeInstanceOf(HostRuntime);
    expect(runtime.getHostSnapshot().servers).toEqual(["everything"]);
  });

  it("getHostSnapshot returns the CURRENT host snapshot, not a cached one", () => {
    const host = new Host({
      style: "mcpjam",
      model: "openai/gpt-4o",
    }).requireServer("everything");
    const runtime = host.withManager(fakeManager(["everything", "extra"]), {
      apiKey: "k",
    });

    expect(runtime.getHostSnapshot().servers).toEqual(["everything"]);
    host.requireServer("extra");
    expect(runtime.getHostSnapshot().servers).toEqual(["everything", "extra"]);
  });

  it("withOptions returns a new runtime with merged defaults and empty history", () => {
    const host = new Host({ style: "mcpjam", model: "openai/gpt-4o" });
    const runtime = host.withManager(fakeManager([]), {
      apiKey: "old-key",
      maxSteps: 5,
    });

    const cloned = runtime.withOptions({ apiKey: "new-key" });

    expect(cloned).not.toBe(runtime);
    expect(cloned.getPromptHistory()).toEqual([]);
  });
});

describe("HostRuntime server validation", () => {
  it("throws clearly when a required server id is not known to the manager", async () => {
    const host = new Host({
      style: "mcpjam",
      model: "openai/gpt-4o",
    }).requireServer("missing");
    const manager = fakeManager(["everything"]);
    const runtime = host.withManager(manager, baseDefaults);

    await expect(runtime.run("hi")).rejects.toThrow(
      /server id\(s\) not registered.*missing.*Known servers: everything/i,
    );
    // No tools fetched if validation failed.
    expect(manager.getToolsForAiSdkSpy).not.toHaveBeenCalled();
  });

  it("skips unknown OPTIONAL servers and passes only known ids to the manager", async () => {
    const host = new Host({
      style: "mcpjam",
      model: "openai/gpt-4o",
      servers: ["everything"],
      optionalServers: ["maybe-here"],
    });
    const manager = fakeManager(["everything"]);
    const runtime = host.withManager(manager, baseDefaults);

    // Now that the dynamic HostRunner is mocked, the full .run() pipeline
    // resolves and we can assert the resolved ids without a downstream failure.
    const result = await runtime.run("hi");
    expect((result as any).kind).toBe("fake-prompt-result");

    expect(manager.getToolsForAiSdkSpy).toHaveBeenCalledTimes(1);
    const [resolvedIds, options] = manager.getToolsForAiSdkSpy.mock.calls[0];
    expect(resolvedIds).toEqual(["everything"]);
    // `mcpjam` style doesn't set respectToolVisibility, so we leave
    // includeAppOnly as undefined / falsy (manager filters by spec default).
    expect(options?.includeAppOnly).not.toBe(true);
  });
});

describe("HostRuntime end-to-end run", () => {
  it("constructs HostRunner with the snapshot + bound apiKey and returns its result", async () => {
    runnerRunSpy.mockClear();
    lastRunnerArgs.config = undefined;

    const host = new Host({
      style: "mcpjam",
      model: "openai/gpt-4o",
    }).requireServer("alpha");
    const manager = fakeManager(["alpha"], {
      alpha: { hello: { _serverId: "alpha" } },
    });
    const runtime = host.withManager(manager, {
      apiKey: "bound-key",
      maxSteps: 7,
    });

    const result = await runtime.run("first message");

    expect((result as any).prompt).toBe("first message");

    // Runner was constructed with the snapshot (HostJson), bound apiKey,
    // and forwarded defaults.
    expect(lastRunnerArgs.config?.apiKey).toBe("bound-key");
    expect(lastRunnerArgs.config?.maxSteps).toBe(7);
    // Manager passed through so the runner can capture widget snapshots.
    expect(lastRunnerArgs.config?.mcpClientManager).toBe(manager);
    // Host snapshot identity: passed as the live snapshot, not the Host
    // instance itself (HostRuntime calls .toJSON()).
    expect(lastRunnerArgs.config?.host?.style).toBe("mcpjam");
    expect(lastRunnerArgs.config?.host?.servers).toEqual(["alpha"]);

    expect(runnerRunSpy).toHaveBeenCalledWith("first message", undefined);
  });

  it("accumulates prompt history across .run() calls and resets cleanly", async () => {
    const host = new Host({ style: "mcpjam", model: "openai/gpt-4o" });
    const runtime = host.withManager(fakeManager([]), baseDefaults);

    expect(runtime.getPromptHistory()).toEqual([]);

    const r1 = await runtime.run("a");
    const r2 = await runtime.run("b");

    const history = runtime.getPromptHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toBe(r1);
    expect(history[1]).toBe(r2);
    expect((history[0] as any).prompt).toBe("a");
    expect((history[1] as any).prompt).toBe("b");

    runtime.resetPromptHistory();
    expect(runtime.getPromptHistory()).toEqual([]);
  });

  it("turns are independent — the second turn does NOT receive turn-1 context unless caller threads it explicitly", async () => {
    runnerRunSpy.mockClear();
    const host = new Host({ style: "mcpjam", model: "openai/gpt-4o" });
    const runtime = host.withManager(fakeManager([]), baseDefaults);

    await runtime.run("a");
    await runtime.run("b");

    // Both calls forward options unchanged — no auto-threaded context.
    expect(runnerRunSpy).toHaveBeenNthCalledWith(1, "a", undefined);
    expect(runnerRunSpy).toHaveBeenNthCalledWith(2, "b", undefined);

    // Explicit context survives the forward.
    await runtime.run("c", { context: { fake: "prior" } as any });
    expect(runnerRunSpy).toHaveBeenNthCalledWith(3, "c", {
      context: { fake: "prior" },
    });
  });

  it("mutating the host between runs is reflected on the NEXT run's snapshot", async () => {
    runnerRunSpy.mockClear();
    const host = new Host({
      style: "mcpjam",
      model: "openai/gpt-4o",
    }).requireServer("alpha");
    const manager = fakeManager(["alpha", "beta"]);
    const runtime = host.withManager(manager, baseDefaults);

    await runtime.run("first");
    expect(lastRunnerArgs.config?.host?.servers).toEqual(["alpha"]);

    host.requireServer("beta");
    await runtime.run("second");
    expect(lastRunnerArgs.config?.host?.servers).toEqual(["alpha", "beta"]);
  });

  it("passes includeAppOnly: true when host opts out of visibility filtering", async () => {
    const host = new Host({
      style: "mcpjam",
      model: "openai/gpt-4o",
      respectToolVisibility: false,
    });
    const manager = fakeManager([]);
    const runtime = host.withManager(manager, baseDefaults);

    await runtime.run("x");

    const lastCall = manager.getToolsForAiSdkSpy.mock.calls.at(-1)!;
    const options = lastCall[1];
    expect(options?.includeAppOnly).toBe(true);
  });
});
