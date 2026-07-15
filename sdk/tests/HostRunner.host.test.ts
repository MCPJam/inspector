import { describe, it, expect } from "vitest";
import { HostRunner } from "../src/HostRunner.js";
import {
  Host,
  isHostJson,
  snapshotHostSource,
} from "../src/host-config/host.js";

describe("HostRunner host integration", () => {
  describe("config.host derives runner defaults", () => {
    it("uses host.model when config.model is absent", () => {
      const host = new Host({
        style: "mcpjam",
        model: "openai/gpt-4o",
      }).requireServer("everything");

      const runner = new HostRunner({
        host,
        tools: [],
        apiKey: "test-key",
      });

      expect(runner.getParsedProvider()).toBe("openai");
      expect(runner.getParsedModel()).toBe("gpt-4o");
    });

    it("explicit config.model wins over host.model", () => {
      const host = new Host({
        style: "mcpjam",
        model: "openai/gpt-4o",
      });

      const runner = new HostRunner({
        host,
        tools: [],
        apiKey: "test-key",
        model: "anthropic/claude-sonnet-4-6",
      });

      expect(runner.getParsedProvider()).toBe("anthropic");
      expect(runner.getParsedModel()).toBe("claude-sonnet-4-6");
    });

    it("uses host.systemPrompt when config.systemPrompt is absent and host sets one", () => {
      const host = new Host({
        style: "mcpjam",
        model: "openai/gpt-4o",
        systemPrompt: "You are a precise calculator.",
      });

      const runner = new HostRunner({
        host,
        tools: [],
        apiKey: "test-key",
      });

      expect(runner.getSystemPrompt()).toBe("You are a precise calculator.");
    });

    it("falls back to the default system prompt when neither config nor host set one", () => {
      const host = new Host({
        style: "mcpjam",
        model: "openai/gpt-4o",
      });

      const runner = new HostRunner({
        host,
        tools: [],
        apiKey: "test-key",
      });

      expect(runner.getSystemPrompt()).toBe("You are a helpful assistant.");
    });
  });

  describe("snapshot semantics", () => {
    it("getHostSnapshot returns a HostJson, not a live Host", () => {
      const host = new Host({
        style: "mcpjam",
        model: "openai/gpt-4o",
      }).requireServer("everything");

      const runner = new HostRunner({
        host,
        tools: [],
        apiKey: "test-key",
      });

      const snap = runner.getHostSnapshot();
      expect(snap).toBeDefined();
      expect(isHostJson(snap)).toBe(true);
      expect(snap).not.toBeInstanceOf(Host);
      expect(snap?.model).toBe("openai/gpt-4o");
      expect(snap?.servers).toEqual(["everything"]);
    });

    it("mutating the original Host after construction does NOT affect the snapshot", () => {
      const host = new Host({
        style: "mcpjam",
        model: "openai/gpt-4o",
      }).requireServer("everything");

      const runner = new HostRunner({
        host,
        tools: [],
        apiKey: "test-key",
      });

      const snapBefore = runner.getHostSnapshot();
      host.requireServer("another");
      host.model = "anthropic/claude-sonnet-4-6";
      const snapAfter = runner.getHostSnapshot();

      expect(snapBefore?.servers).toEqual(["everything"]);
      expect(snapAfter?.servers).toEqual(["everything"]);
      expect(snapAfter?.model).toBe("openai/gpt-4o");
    });

    it("a pre-snapshotted HostJson passes through without re-snapshotting", () => {
      const host = new Host({
        style: "mcpjam",
        model: "openai/gpt-4o",
      }).requireServer("everything");
      const preSnap = host.toJSON();

      const runner = new HostRunner({
        host: preSnap,
        tools: [],
        apiKey: "test-key",
      });

      // Same reference — snapshotHostSource short-circuits on isHostJson.
      expect(runner.getHostSnapshot()).toBe(preSnap);
    });

    it("a HostInit is normalized into a HostJson snapshot", () => {
      const runner = new HostRunner({
        host: { style: "mcpjam", model: "openai/gpt-4o", servers: ["a"] },
        tools: [],
        apiKey: "test-key",
      });

      const snap = runner.getHostSnapshot();
      expect(isHostJson(snap)).toBe(true);
      expect(snap?.servers).toEqual(["a"]);
    });

    it("a HostInit shaped like { style, model, servers } is NOT misclassified as a HostJson — it gets normalized", () => {
      // Regression: previously `isHostJson` only checked style/model/servers,
      // so a HostInit with those three fields bypassed normalization and
      // the runner ended up with `optionalServers`, `connectionDefaults`,
      // `temperature` etc. missing entirely.
      const naked = { style: "mcpjam", model: "openai/gpt-4o", servers: ["a"] };
      expect(isHostJson(naked)).toBe(false);

      const runner = new HostRunner({
        host: naked,
        tools: [],
        apiKey: "test-key",
      });
      const snap = runner.getHostSnapshot();
      expect(snap).toBeDefined();
      // The snapshot is now the result of `new Host(naked).toJSON()` — every
      // field that `HostJson` requires must be present with its normalized
      // default.
      expect(Array.isArray(snap?.optionalServers)).toBe(true);
      expect(typeof snap?.connectionDefaults).toBe("object");
      expect(typeof snap?.temperature).toBe("number");
      expect(typeof snap?.requireToolApproval).toBe("boolean");
      expect(typeof snap?.systemPrompt).toBe("string");
      expect(typeof snap?.clientCapabilities).toBe("object");
      expect(typeof snap?.hostContext).toBe("object");
    });
  });

  describe("withOptions preserves host snapshot across clones", () => {
    it("clone keeps getHostSnapshot() populated when constructed from a Host", () => {
      const host = new Host({
        style: "mcpjam",
        model: "openai/gpt-4o",
      }).requireServer("everything");

      const runner = new HostRunner({
        host,
        tools: [],
        apiKey: "test-key",
      });

      const clone = runner.withOptions({});

      const originalSnap = runner.getHostSnapshot();
      const cloneSnap = clone.getHostSnapshot();
      expect(cloneSnap).toBeDefined();
      // Same snapshot reference is OK — the snapshot is immutable.
      expect(cloneSnap?.servers).toEqual(originalSnap?.servers);
      expect(cloneSnap?.model).toBe("openai/gpt-4o");
    });

    it("clone keeps host-derived injectOpenAiCompat after withOptions({})", () => {
      // `mcpjam` style → resolveOpenAiCompatForHostConfig === true. The
      // clone must carry that through.
      const host = new Host({ style: "mcpjam", model: "openai/gpt-4o" });
      const runner = new HostRunner({ host, tools: [], apiKey: "test-key" });
      const clone = runner.withOptions({});
      // Indirect: a runner constructed without preserving the host
      // would fall back to the explicit-model branch and lose the
      // host policy entirely.
      expect(clone.getHostPolicy()?.hostStyle).toBe("mcpjam");
    });

    it("explicit options.host wins over the existing snapshot", () => {
      const baseHost = new Host({
        style: "claude",
        model: "anthropic/claude-3",
      });
      const runner = new HostRunner({ host: baseHost, tools: [], apiKey: "k" });

      const otherHost = new Host({
        style: "mcpjam",
        model: "openai/gpt-4o",
      }).requireServer("alpha");

      const clone = runner.withOptions({ host: otherHost });
      expect(clone.getHostSnapshot()?.style).toBe("mcpjam");
      expect(clone.getHostSnapshot()?.servers).toEqual(["alpha"]);
    });

    it("withOptions({ host: newHost }) lets the new host drive defaults", () => {
      // Regression: previously `withOptions` preserved `this.model`
      // unconditionally, so replacing the host left the clone running
      // against the old host's model (and likewise systemPrompt /
      // temperature / injectOpenAiCompat). Now: when `options.host` is
      // supplied, parent defaults are NOT carried — the new host's
      // snapshot drives them.
      const hostA = new Host({
        style: "claude",
        model: "anthropic/claude-3",
        systemPrompt: "Be terse.",
        temperature: 0.1,
      });
      const runnerA = new HostRunner({
        host: hostA,
        tools: [],
        apiKey: "test-key",
      });

      const hostB = new Host({
        style: "mcpjam",
        model: "openai/gpt-5-mini",
        systemPrompt: "Be playful.",
        temperature: 0.9,
      });
      const clone = runnerA.withOptions({ host: hostB });

      // Model: drives from hostB, not from runnerA's resolved model.
      expect(clone.getParsedProvider()).toBe("openai");
      expect(clone.getParsedModel()).toBe("gpt-5-mini");
      // systemPrompt + temperature: derived from hostB's snapshot.
      expect(clone.getSystemPrompt()).toBe("Be playful.");
      // injectOpenAiCompat: hostB is mcpjam style → true (hostA was claude → false).
      expect(clone.getHostPolicy()?.hostStyle).toBe("mcpjam");
    });

    it("withOptions({ host: newHost }) re-applies the visibility filter to the raw tool input", () => {
      // Regression: previously the clone reused `this.tools` (the
      // already-filtered, already-converted `ToolSet`), so replacing
      // the host with a stricter `respectToolVisibility` left app-only
      // tools that the parent had retained sitting in the new runner.
      // Now `rawTools` is preserved and the new constructor re-runs the
      // prep step under the replacement host's policy.
      const appOnlyTool = {
        name: "secret_app_only",
        description: "app-only widget tool",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
        _meta: { ui: { visibility: ["app"] } },
      } as any;
      const visibleTool = {
        name: "visible_tool",
        description: "regular tool",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
        _meta: {},
      } as any;

      // Loose parent host — keeps app-only tools.
      const looseHost = new Host({
        style: "mcpjam",
        model: "openai/gpt-4o",
        respectToolVisibility: false,
      });
      const looseRunner = new HostRunner({
        host: looseHost,
        tools: [appOnlyTool, visibleTool],
        apiKey: "k",
      });
      // Both tools are in the parent's prepared set.
      expect(Object.keys(looseRunner.getTools()).sort()).toEqual([
        "secret_app_only",
        "visible_tool",
      ]);

      // Strict replacement host — drops app-only tools.
      const strictHost = new Host({
        style: "claude",
        model: "anthropic/claude-3",
        // respectToolVisibility undefined → spec default → filter
      });
      const strictClone = looseRunner.withOptions({ host: strictHost });

      // The clone must re-filter; `secret_app_only` should be gone.
      expect(Object.keys(strictClone.getTools())).toEqual(["visible_tool"]);
    });

    it("withOptions({}) without host change preserves the parent's prepared tools (no re-prep regression)", () => {
      const tool = {
        name: "t",
        description: "",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
        _meta: {},
      } as any;
      const host = new Host({ style: "mcpjam", model: "openai/gpt-4o" });
      const runner = new HostRunner({ host, tools: [tool], apiKey: "k" });

      const clone = runner.withOptions({});
      expect(Object.keys(clone.getTools())).toEqual(["t"]);
    });

    it("withOptions({ host: newHost, model: 'X' }) still honors explicit model override", () => {
      const hostA = new Host({ style: "claude", model: "anthropic/claude-3" });
      const runnerA = new HostRunner({ host: hostA, tools: [], apiKey: "k" });

      const hostB = new Host({ style: "mcpjam", model: "openai/gpt-5-mini" });
      const clone = runnerA.withOptions({
        host: hostB,
        model: "openai/gpt-4o",
      });

      expect(clone.getParsedProvider()).toBe("openai");
      expect(clone.getParsedModel()).toBe("gpt-4o");
    });

    it("preserves an explicit model override through withOptions({})", () => {
      // Regression: when constructed as `new HostRunner({ host, model: X })`
      // the explicit model should win at clone time too. Otherwise
      // `EvalTest`'s per-iteration `executor.withOptions({})` silently
      // switches the iteration runner from `X` back to `host.model`.
      const host = new Host({ style: "mcpjam", model: "openai/gpt-4o" });
      const runner = new HostRunner({
        host,
        tools: [],
        apiKey: "test-key",
        model: "anthropic/claude-sonnet-4-6",
      });

      expect(runner.getParsedProvider()).toBe("anthropic");
      expect(runner.getParsedModel()).toBe("claude-sonnet-4-6");

      const clone = runner.withOptions({});
      expect(clone.getParsedProvider()).toBe("anthropic");
      expect(clone.getParsedModel()).toBe("claude-sonnet-4-6");

      // Explicit override at clone time still wins.
      const clone2 = runner.withOptions({ model: "openai/gpt-5-mini" });
      expect(clone2.getParsedProvider()).toBe("openai");
      expect(clone2.getParsedModel()).toBe("gpt-5-mini");
    });

    it("legacy explicit-model runner stays host-less through withOptions", () => {
      const runner = new HostRunner({
        tools: [],
        apiKey: "test-key",
        model: "openai/gpt-4o",
      });

      const clone = runner.withOptions({});
      expect(clone.getHostSnapshot()).toBeUndefined();
      expect(clone.getHostPolicy()).toBeUndefined();
    });
  });

  describe("structural manager compatibility (widget snapshot guard)", () => {
    it("does NOT crash when the manager lacks getToolMetadata / readResource", async () => {
      // Regression: `HostRuntimeManager` only requires `hasServer` +
      // `getToolsForAiSdk`, but `HostRunner` used to dereference
      // `mcpClientManager.getToolMetadata(...)` unconditionally during
      // widget snapshot capture. A custom structural manager that
      // satisfied `HostRuntimeManager` would type-check and crash at
      // runtime.
      const structuralManager = {
        hasServer: () => true,
        listServers: () => ["alpha"],
        getToolsForAiSdk: async () => ({}),
        // intentionally NO getToolMetadata / readResource
      };

      const runner = new HostRunner({
        host: new Host({ style: "mcpjam", model: "openai/gpt-4o" }),
        tools: [],
        apiKey: "test-key",
        // Bypass the concrete-class type — same shape HostRuntime passes via
        // its `as never` cast.
        mcpClientManager: structuralManager as never,
      });

      const buffer = new Map();
      // The capture method is private at the TS level; cast to call it.
      // It must short-circuit on the missing-method guard rather than
      // throw on `undefined is not a function`.
      await (runner as any).captureMcpAppSnapshot({
        toolName: "whatever",
        tool: { _serverId: "alpha" },
        options: { toolCallId: "tc-1" },
        toolInput: {},
        toolOutput: {},
        snapshotBuffer: buffer,
      });
      expect(buffer.size).toBe(0);
    });
  });

  describe("legacy explicit-model path", () => {
    it("constructs without host when model is given", () => {
      const runner = new HostRunner({
        tools: [],
        apiKey: "test-key",
        model: "openai/gpt-4o",
      });

      expect(runner.getHostSnapshot()).toBeUndefined();
      expect(runner.getHostPolicy()).toBeUndefined();
      expect(runner.getParsedProvider()).toBe("openai");
    });

    it("throws if neither host nor model is provided", () => {
      // @ts-expect-error — discriminated union forbids this at compile time;
      // exercising the runtime defense-in-depth.
      expect(() => new HostRunner({ tools: [], apiKey: "k" })).toThrow(
        /requires either `host`.*or an explicit `model`/i
      );
    });
  });
});

describe("snapshotHostSource + isHostJson", () => {
  it("isHostJson rejects a Host instance", () => {
    const host = new Host({ style: "mcpjam", model: "openai/gpt-4o" });
    expect(isHostJson(host)).toBe(false);
  });

  it("isHostJson accepts a HostJson", () => {
    const host = new Host({ style: "mcpjam", model: "openai/gpt-4o" });
    const snap = host.toJSON();
    expect(isHostJson(snap)).toBe(true);
  });

  it("snapshotHostSource is idempotent on HostJson", () => {
    const snap = new Host({ style: "mcpjam", model: "openai/gpt-4o" }).toJSON();
    expect(snapshotHostSource(snap)).toBe(snap);
  });

  it("snapshotHostSource preserves explicit image policies on HostJson", () => {
    const snap = new Host({
      style: "mcpjam",
      model: "openai/gpt-4o",
      modelVisibleMcpToolResults: {
        directContent: { image: false },
        embeddedResources: { blob: { image: false } },
        linkedResources: { blob: { image: true } },
      },
      mcpToolResultImageRendering: { placement: "collapsed" },
    }).toJSON();

    const normalized = snapshotHostSource(snap);
    expect(normalized).toBe(snap);
    expect(normalized.modelVisibleMcpToolResults).toEqual({
      directContent: { image: false },
      embeddedResources: { blob: { image: false } },
      linkedResources: { blob: { image: true } },
    });
    expect(normalized.mcpToolResultImageRendering).toEqual({
      placement: "collapsed",
    });
  });

  it("snapshotHostSource calls toJSON on a Host", () => {
    const host = new Host({ style: "mcpjam", model: "openai/gpt-4o" });
    const snap = snapshotHostSource(host);
    expect(snap).not.toBe(host);
    expect(isHostJson(snap)).toBe(true);
  });

  it("snapshotHostSource constructs from a HostInit", () => {
    const snap = snapshotHostSource({
      style: "mcpjam",
      model: "openai/gpt-4o",
    });
    expect(isHostJson(snap)).toBe(true);
    expect(snap.model).toBe("openai/gpt-4o");
  });
});
