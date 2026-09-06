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
  truncationMarker,
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
    // The marker carries the COUNT as a number; the renderer turns it into the
    // retrieval verb, using the ref the parent was actually given. It used to
    // bake a sentence in here naming a `<selector for this element>`
    // placeholder that nobody could type out.
    const markers: A11yNode[] = [];
    const walk = (node: A11yNode) => {
      if (node.role === "omitted") markers.push(node);
      for (const child of node.children ?? []) walk(child);
    };
    walk(result.tree!);
    expect(markers.length).toBe(result.omittedSubtrees);
    expect(typeof markers[0].hiddenNodes).toBe("number");
    expect(markers[0].hiddenNodes as number).toBeGreaterThan(0);
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
    expect(jsonOf(result.tree)).toMatch(/"hiddenNodes":\d+/);
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
    expect(capped).toContain("truncated");
    expect(new TextEncoder().encode(capped).byteLength).toBeLessThanOrEqual(100);
  });

  it("counts BYTES, not code units, and never splits a character", () => {
    // Four-byte emoji: a naive `slice` would cut one in half and emit U+FFFD.
    const emoji = "😀".repeat(50);
    const capped = capText(emoji, 40);
    expect(capped).not.toContain("�");
    expect(new TextEncoder().encode(capped).byteLength).toBeLessThanOrEqual(40);
  });
});

describe("capText — the marker states both sizes", () => {
  it("reports how much was shown and how much there was", () => {
    const capped = capText("x".repeat(500), 100);
    const match = /showing (\d+) of (\d+) bytes/.exec(capped);
    expect(match, capped).not.toBeNull();
    const [, shown, total] = match!;
    expect(Number(total)).toBe(500);
    // The reader can tell a cosmetic cut from one that dropped the page.
    expect(Number(shown)).toBe(
      new TextEncoder().encode(capped.slice(0, capped.indexOf("\n…["))).byteLength,
    );
  });

  it("names the retrieval verb when the caller supplies one", () => {
    const capped = capText("x".repeat(500), 200, "re-observe with a narrower root");
    expect(capped).toContain("re-observe with a narrower root");
  });

  it("stays within budget even when the marker's digits grow", () => {
    // The reserve is computed from the LONGEST marker the call can produce, so
    // one extra digit can never push the result past the cap the CALLER is
    // doing its own arithmetic against.
    const encoder = new TextEncoder();
    for (const maxBytes of [60, 61, 99, 100, 101, 999, 1_000, 1_001]) {
      const capped = capText("y".repeat(20_000), maxBytes, "narrow the root");
      expect(
        encoder.encode(capped).byteLength,
        `budget ${maxBytes}`,
      ).toBeLessThanOrEqual(maxBytes);
    }
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
    expect(result.entries[0].text).toContain("truncated");
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
    expect(result.output as string).toContain("truncated");
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

describe("observation budgets — pathological inputs (review follow-up)", () => {
  it("survives a tree deep enough to blow a recursive stack", () => {
    // The node count runs at FULL depth (it is how a marker knows what it is
    // hiding), so it meets the whole tree however deep. Throwing here would
    // fail the very observation the budget exists to make reportable.
    let root: A11yNode = { role: "leaf" };
    for (let i = 0; i < 60_000; i += 1) {
      root = { role: "node", children: [root] };
    }
    const capped = capA11yTree(root, { maxNodes: 50, maxDepth: 5 });
    expect(capped.totalNodes).toBe(60_001);
    expect(capped.omittedSubtrees).toBeGreaterThan(0);
  });

  it("never returns more bytes than asked for, even below the marker's length", () => {
    // A per-entry cap sits inside a total cap; a `capText` that overshot its
    // own budget would break the caller's arithmetic, not just its own.
    const encoder = new TextEncoder();
    const suffixBytes = encoder.encode(truncationMarker(999, 999)).byteLength;
    for (const maxBytes of [0, 1, 2, suffixBytes - 1, suffixBytes, suffixBytes + 1]) {
      const capped = capText("hello world, this is a long line", maxBytes);
      expect(encoder.encode(capped).byteLength).toBeLessThanOrEqual(maxBytes);
    }
  });

  it("still never splits a multi-byte character under a tiny budget", () => {
    // "日" is 3 bytes; a 2-byte budget must yield nothing, not half a glyph
    // (a U+FFFD replacement is itself 3 bytes and would overshoot).
    const encoder = new TextEncoder();
    for (const maxBytes of [0, 1, 2, 3, 4, 5]) {
      const capped = capText("日本語テキスト", maxBytes);
      expect(encoder.encode(capped).byteLength).toBeLessThanOrEqual(maxBytes);
      expect(capped).not.toContain("�");
    }
  });
});
