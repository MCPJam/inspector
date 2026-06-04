import { describe, it, expect } from "vitest";
import { HostRunner } from "../src/HostRunner.js";
import { Host, isHostJson, snapshotHostSource } from "../src/host-config/host.js";

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
        /requires either `host`.*or an explicit `model`/i,
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
