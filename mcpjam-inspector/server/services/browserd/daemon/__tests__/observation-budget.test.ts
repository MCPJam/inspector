/**
 * L9 — omit, don't truncate. The distinction these tests defend: a model
 * reading a CUT structure cannot tell a missing field from a truncated one,
 * so structures lose whole subtrees (with a marker naming the retrieval verb)
 * while flat text is byte-cut (where the cut is unambiguous).
 */
import { describe, expect, it } from "vitest";
import {
  capA11yTree,
  capConsole,
  capText,
  capToolOutput,
  TRUNCATION_SUFFIX,
  type A11yNode,
} from "../observation-budget";

function tree(depth: number, breadth: number): A11yNode {
  const build = (level: number): A11yNode =>
    level === 0
      ? { role: "leaf", name: `leaf-${level}` }
      : {
          role: "group",
          name: `level-${level}`,
          children: Array.from({ length: breadth }, () => build(level - 1)),
        };
  return build(depth);
}

function jsonOf(node: A11yNode | null): string {
  return JSON.stringify(node);
}

describe("capA11yTree", () => {
  it("returns a small tree untouched", () => {
    const small = tree(2, 2);
    const result = capA11yTree(small, { maxNodes: 400, maxDepth: 12 });
    expect(result.omittedSubtrees).toBe(0);
    expect(jsonOf(result.tree)).toBe(jsonOf(small));
  });

  it("omits whole subtrees past the node budget, never a partial node", () => {
    const big = tree(4, 4); // 341 nodes
    const result = capA11yTree(big, { maxNodes: 20, maxDepth: 12 });

    expect(result.totalNodes).toBeGreaterThan(300);
    expect(result.omittedSubtrees).toBeGreaterThan(0);
    // Every node in the output is complete: the tree round-trips through JSON
    // (a partially-serialized node could not).
    const serialized = jsonOf(result.tree);
    expect(() => JSON.parse(serialized)).not.toThrow();
    // The marker tells the model how to get what is missing.
    const markers: string[] = [];
    const walk = (node: A11yNode) => {
      if (node.role === "omitted") markers.push(node.name ?? "");
      for (const child of node.children ?? []) walk(child);
    };
    walk(result.tree!);
    expect(markers.length).toBe(result.omittedSubtrees);
    expect(markers[0]).toContain('mode:"a11y"');
    expect(markers[0]).toContain("rootSelector");
  });

  it("omits below maxDepth rather than deepening", () => {
    const deep = tree(6, 1);
    const result = capA11yTree(deep, { maxNodes: 400, maxDepth: 2 });
    let node = result.tree!;
    let depth = 0;
    while (node.children?.length && node.children[0].role !== "omitted") {
      node = node.children[0];
      depth += 1;
    }
    expect(depth).toBeLessThanOrEqual(2);
    expect(result.omittedSubtrees).toBe(1);
  });

  it("reports the hidden node count so the model knows the scale", () => {
    const big = tree(3, 3);
    const result = capA11yTree(big, { maxNodes: 3, maxDepth: 12 });
    expect(jsonOf(result.tree)).toMatch(/\d+ node\(s\) under/);
  });

  it("handles null, empty and childless roots", () => {
    expect(capA11yTree(null)).toEqual({
      tree: null,
      omittedSubtrees: 0,
      totalNodes: 0,
    });
    expect(capA11yTree(undefined).tree).toBeNull();
    const leaf = capA11yTree({ role: "leaf" });
    expect(leaf.tree).toEqual({ role: "leaf" });
    expect(leaf.totalNodes).toBe(1);
    const emptyChildren = capA11yTree({ role: "group", children: [] });
    expect(emptyChildren.omittedSubtrees).toBe(0);
  });
});

describe("capText", () => {
  it("leaves text within budget alone", () => {
    expect(capText("hello", 100)).toBe("hello");
    expect(capText("", 10)).toBe("");
  });

  it("cuts to the byte budget and says it cut", () => {
    const capped = capText("x".repeat(500), 100);
    expect(capped.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    expect(new TextEncoder().encode(capped).byteLength).toBeLessThanOrEqual(100);
  });

  it("counts BYTES, not code units, and never splits a character", () => {
    // Four-byte emoji: a naive `slice` would cut one in half and emit U+FFFD.
    const emoji = "😀".repeat(50);
    const capped = capText(emoji, 40);
    expect(capped).not.toContain("�");
    expect(new TextEncoder().encode(capped).byteLength).toBeLessThanOrEqual(40);
    expect(capped.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });
});

describe("capConsole", () => {
  const entries = Array.from({ length: 120 }, (_, index) => ({
    type: "log",
    text: `entry-${index}`,
    at: index,
  }));

  it("keeps the NEWEST entries — console is a tail, not a document", () => {
    const result = capConsole(entries, { maxEntries: 10, maxEntryBytes: 100 });
    expect(result.entries).toHaveLength(10);
    expect(result.entries[0].text).toBe("entry-110");
    expect(result.entries.at(-1)!.text).toBe("entry-119");
    expect(result.omitted).toBe(110);
  });

  it("byte-caps each entry (one stack trace must not eat the budget)", () => {
    const result = capConsole(
      [{ type: "error", text: "y".repeat(5_000), at: 1 }],
      { maxEntries: 10, maxEntryBytes: 100 },
    );
    expect(result.entries[0].text.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it("handles an empty console", () => {
    expect(capConsole([])).toEqual({ entries: [], omitted: 0 });
  });
});

describe("capToolOutput", () => {
  it("returns a small object whole", () => {
    const output = { ok: true, rows: [1, 2, 3] };
    expect(capToolOutput(output, 1_000)).toEqual({ output, omitted: false });
  });

  it("REPLACES an oversized object rather than half-serializing it", () => {
    const output = { rows: Array.from({ length: 5_000 }, (_, i) => i) };
    const result = capToolOutput(output, 200);
    expect(result.omitted).toBe(true);
    expect(typeof result.output).toBe("string");
    expect(result.output as string).toContain("omitted");
    // Not a truncated JSON fragment — a model must never see one.
    expect(result.output as string).not.toMatch(/^\{"rows":\[/);
  });

  it("byte-truncates a string output, where the cut is unambiguous", () => {
    const result = capToolOutput("z".repeat(1_000), 100);
    expect(result.omitted).toBe(true);
    expect((result.output as string).endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it("survives an unserializable output", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = capToolOutput(cyclic, 1_000);
    expect(result.omitted).toBe(true);
    expect(result.output).toContain("could not be serialized");
  });

  it("passes null and undefined through when they fit", () => {
    expect(capToolOutput(null, 100)).toEqual({ output: null, omitted: false });
    expect(capToolOutput(undefined, 100)).toEqual({
      output: undefined,
      omitted: false,
    });
  });
});
