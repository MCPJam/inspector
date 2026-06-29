import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";
import {
  getHarnessAdapter,
  isHarnessId,
  registeredHarnessIds,
} from "../registry";

describe("harness registry", () => {
  it("returns the claude-code adapter", () => {
    expect(getHarnessAdapter("claude-code").id).toBe("claude-code");
  });

  it("returns the codex adapter", () => {
    const a = getHarnessAdapter("codex");
    expect(a.id).toBe("codex");
    expect(a.displayName).toBe("Codex");
    // Codex v1: no MCP servers, no skills, can't pause for tool approval.
    expect(a.supportsSelectedMcpServers).toBe(false);
    expect(a.supportsSkills).toBe(false);
    expect(a.supportsNativeToolApproval).toBe(false);
    expect(a.requiresComputer).toBe(true);
    expect(a.fileChangeToolName).toBe("fileChange");
  });

  it("maps host model ids to Claude Code CLI-native aliases", () => {
    const { toNativeModel } = getHarnessAdapter("claude-code");
    expect(toNativeModel?.("anthropic/claude-haiku-4.5")).toBe("haiku");
    expect(toNativeModel?.("anthropic/claude-opus-4-6")).toBe("opus");
    expect(toNativeModel?.("anthropic/claude-sonnet-4-6")).toBe("sonnet");
    expect(toNativeModel?.("openai/gpt-5")).toBeUndefined();
  });

  it("maps Codex models via an allowlist (gpt-5 family only)", () => {
    const { toNativeModel } = getHarnessAdapter("codex");
    expect(toNativeModel?.("openai/gpt-5-nano")).toBe("gpt-5-nano");
    expect(toNativeModel?.("openai/gpt-5.5")).toBe("gpt-5.5");
    // Not a blanket strip: non-gpt-5 OpenAI ids ⇒ undefined (Codex default).
    expect(toNativeModel?.("openai/o1")).toBeUndefined();
    // Non-OpenAI ids never map.
    expect(toNativeModel?.("anthropic/claude-haiku-4.5")).toBeUndefined();
  });

  it("supportsModel: Claude Code runs anything, Codex only gpt-5", () => {
    const cc = getHarnessAdapter("claude-code");
    const codex = getHarnessAdapter("codex");
    expect(cc.supportsModel("anthropic/claude-haiku-4.5")).toBe(true);
    expect(cc.supportsModel("openai/gpt-5-nano")).toBe(true);
    expect(codex.supportsModel("openai/gpt-5-nano")).toBe(true);
    // MCPJam-provided but not Codex-mappable ⇒ unsupported (rejected in preflight).
    expect(codex.supportsModel("anthropic/claude-haiku-4.5")).toBe(false);
    expect(codex.supportsModel("openai/o1")).toBe(false);
  });

  it("Claude Code attributes mcp__ tool names; Codex passes them through", () => {
    const keyToServerId = { weather: "srv_123" };
    expect(
      getHarnessAdapter("claude-code").parseToolName(
        "mcp__weather__forecast",
        keyToServerId,
      ),
    ).toEqual({ serverId: "srv_123", toolName: "forecast" });
    // Codex v1 has no MCP namespacing — names pass through as native tools.
    expect(
      getHarnessAdapter("codex").parseToolName(
        "mcp__weather__forecast",
        keyToServerId,
      ),
    ).toEqual({ toolName: "mcp__weather__forecast" });
  });

  it("isHarnessId narrows registered ids and rejects junk", () => {
    expect(isHarnessId("claude-code")).toBe(true);
    expect(isHarnessId("codex")).toBe(true);
    expect(isHarnessId("pi")).toBe(false);
    expect(isHarnessId("__proto__")).toBe(false);
    expect(isHarnessId(undefined)).toBe(false);
  });

  it("registry keys are at parity with the SDK HARNESS_IDS (no drift)", () => {
    expect([...registeredHarnessIds()].sort()).toEqual([...HARNESS_IDS].sort());
  });

  it("throws for an unknown harness id (e.g. a not-yet-installed adapter)", () => {
    // `pi` is a plausible-but-unregistered runtime (codex is now installed).
    expect(() => getHarnessAdapter("pi")).toThrow(/Unsupported harness/);
  });

  describe("deliverMcpServers (refactor guard — Claude .mcp.json unchanged)", () => {
    const mcpJson = {
      mcpServers: {
        weather: { type: "http" as const, url: "https://example.com/mcp" },
      },
    };

    it("Claude Code writes the same path + content the inline write did", async () => {
      const adapter = getHarnessAdapter("claude-code");
      const writes: { path: string; content: string }[] = [];
      await adapter.deliverMcpServers?.({
        writeTextFile: async (a) => {
          writes.push(a);
        },
        sessionWorkDir: "/home/user/work",
        mcpJson,
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]!.path).toBe("/home/user/work/.mcp.json");
      // Content is the canonical serialization (same helper as before the refactor).
      expect(JSON.parse(writes[0]!.content)).toEqual(mcpJson);
    });

    it("Codex declares no MCP delivery (v1: no servers)", () => {
      expect(getHarnessAdapter("codex").deliverMcpServers).toBeUndefined();
      expect(getHarnessAdapter("codex").supportsSelectedMcpServers).toBe(false);
    });
  });

  describe("listBuiltinTools (display catalog)", () => {
    // The set evolves with the published adapter, so assert MEMBERSHIP of known
    // tools — never a fixed count.
    const list = getHarnessAdapter("claude-code").listBuiltinTools();

    it("constructs without auth/sandbox and returns a non-empty catalog", () => {
      expect(list.length).toBeGreaterThan(0);
    });

    it("includes the known core + native-only tools (keyed by record key)", () => {
      const keys = new Set(list.map((t) => t.key));
      for (const expected of [
        "read",
        "write",
        "edit",
        "bash",
        "glob",
        "grep",
        "webSearch",
        "WebFetch",
        "NotebookEdit",
      ]) {
        expect(keys).toContain(expected);
      }
    });

    it("normalizes every entry: non-empty name, JSON-Schema where present, sorted", () => {
      for (const t of list) {
        expect(typeof t.name).toBe("string");
        expect(t.name.length).toBeGreaterThan(0);
        if (t.inputSchema !== undefined) {
          expect(typeof t.inputSchema).toBe("object");
        }
      }
      const names = list.map((t) => t.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });

    it("at least one tool exposes a usable input schema (bash/read take params)", () => {
      const withSchema = list.filter((t) => t.inputSchema !== undefined);
      expect(withSchema.length).toBeGreaterThan(0);
    });
  });
});
