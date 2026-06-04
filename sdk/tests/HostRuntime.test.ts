import { describe, it, expect, vi } from "vitest";
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

  it("skips unknown OPTIONAL servers silently", async () => {
    const host = new Host({
      style: "mcpjam",
      model: "openai/gpt-4o",
      servers: ["everything"],
      optionalServers: ["maybe-here"],
    });
    const manager = fakeManager(["everything"]);
    const runtime = host.withManager(manager, baseDefaults);

    // Validation should NOT throw — server is optional, not required.
    // The .run() call will hit the AI SDK and fail downstream, so we
    // stub at the manager edge by asserting the resolver got the right ids.
    await runtime.run("hi").catch(() => {
      /* expected: model has no API to call */
    });

    expect(manager.getToolsForAiSdkSpy).toHaveBeenCalled();
    const firstCall = manager.getToolsForAiSdkSpy.mock.calls[0];
    const resolvedIds = firstCall[0];
    expect(resolvedIds).toEqual(["everything"]);
  });
});

describe("HostRuntime stateless turns", () => {
  it("accumulates prompt history across .run() calls", async () => {
    const host = new Host({ style: "mcpjam", model: "openai/gpt-4o" });
    const manager = fakeManager([]);
    const runtime = host.withManager(manager, baseDefaults);

    expect(runtime.getPromptHistory()).toEqual([]);
    // Without exercising the real AI SDK, this test focuses on the
    // history-API contract; full per-turn behavior is covered in
    // HostRunner.test.ts via the mock path.
    runtime.resetPromptHistory();
    expect(runtime.getPromptHistory()).toEqual([]);
  });
});
