import { describe, expect, it } from "vitest";
import { getHarnessAdapter } from "../registry";

describe("harness registry", () => {
  it("returns the claude-code adapter", () => {
    expect(getHarnessAdapter("claude-code").id).toBe("claude-code");
  });

  it("maps host model ids to Claude Code CLI-native aliases", () => {
    const { toNativeModel } = getHarnessAdapter("claude-code");
    expect(toNativeModel?.("anthropic/claude-haiku-4.5")).toBe("haiku");
    expect(toNativeModel?.("anthropic/claude-opus-4-6")).toBe("opus");
    expect(toNativeModel?.("anthropic/claude-sonnet-4-6")).toBe("sonnet");
    expect(toNativeModel?.("openai/gpt-5")).toBeUndefined();
  });

  it("throws for an unknown harness id (e.g. a not-yet-installed adapter)", () => {
    expect(() => getHarnessAdapter("codex")).toThrow(/Unsupported harness/);
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
