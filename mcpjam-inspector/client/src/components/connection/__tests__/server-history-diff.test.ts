import { describe, expect, it } from "vitest";
import {
  diffDiscoveryField,
  diffFieldValues,
  diffToolField,
  revisionMissing,
  type DiffLine,
} from "../server-history-diff";

/** One line per row, git-style, with changed words wrapped in [brackets]. */
function render(lines: DiffLine[]): string[] {
  return lines.map((line) => {
    if (line.kind === "gap") return `… ${line.count}`;
    if (line.kind === "context") return `  ${line.text}`;
    const text = line.segments
      .map((segment) => (segment.changed ? `[${segment.text}]` : segment.text))
      .join("");
    return `${line.kind === "removed" ? "-" : "+"} ${text}`;
  });
}

function linesOf(diff: ReturnType<typeof diffFieldValues>): string[] {
  if (diff.kind !== "lines")
    throw new Error(`expected lines, got ${diff.kind}`);
  return render(diff.lines);
}

describe("diffFieldValues", () => {
  it("marks the words that changed in a one-line description", () => {
    const diff = diffFieldValues(
      "List assets on the exchange.",
      "List assets on the exchange, with custody status.",
      "text",
    );
    expect(linesOf(diff)).toEqual([
      "- List assets on the exchange.",
      "+ List assets on the exchange[, with custody status].",
    ]);
  });

  it("keeps three lines of context and collapses the rest", () => {
    const before = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    const after = [...before];
    after[9] = "line ten";
    expect(
      linesOf(diffFieldValues(before.join("\n"), after.join("\n"), "text")),
    ).toEqual([
      "… 6",
      "  line 7",
      "  line 8",
      "  line 9",
      "- line [10]",
      "+ line [ten]",
      "  line 11",
      "  line 12",
    ]);
  });

  it("shows a value that appeared as all added lines", () => {
    expect(linesOf(diffFieldValues(undefined, "a\nb", "text"))).toEqual([
      "+ a",
      "+ b",
    ]);
  });

  it("shows a value that went away as all removed lines", () => {
    expect(linesOf(diffFieldValues("gone", undefined, "text"))).toEqual([
      "- gone",
    ]);
  });

  it("does not mark words when a line was rewritten outright", () => {
    expect(
      linesOf(
        diffFieldValues("Fetch prices.", "Use cached quotes only.", "text"),
      ),
    ).toEqual(["- Fetch prices.", "+ Use cached quotes only."]);
  });

  it("ignores key order and required order, as the backend does", () => {
    const before = {
      type: "object",
      required: ["b", "a"],
      properties: { b: { type: "string" }, a: { type: "number" } },
    };
    const after = {
      properties: {
        a: { type: "number" },
        b: { type: "string", maxLength: 10 },
      },
      required: ["a", "b"],
      type: "object",
    };
    expect(linesOf(diffFieldValues(before, after, "json"))).toEqual([
      "… 3",
      '        "type": "number"',
      "      },",
      '      "b": {',
      '+       "maxLength": 10,',
      '        "type": "string"',
      "      }",
      "    },",
      "… 6",
    ]);
  });

  it("reads short values as old and new", () => {
    expect(diffFieldValues("4.1.2", "1.7.0", "inline")).toEqual({
      kind: "inline",
      before: "4.1.2",
      after: "1.7.0",
    });
    expect(diffFieldValues(undefined, "Markets", "inline")).toEqual({
      kind: "inline",
      before: undefined,
      after: "Markets",
    });
  });

  it("says unchanged when only a final newline differs", () => {
    expect(diffFieldValues("same", "same\n", "text")).toEqual({
      kind: "lines",
      lines: [],
    });
  });
});

describe("field readers", () => {
  it("diffs a tool's description as text and its schema as JSON", () => {
    const before = { name: "t", description: "Old.", inputSchema: { a: 1 } };
    const after = { name: "t", description: "New.", inputSchema: { a: 2 } };
    expect(diffToolField(before, after, "description").kind).toBe("lines");
    expect(linesOf(diffToolField(before, after, "inputSchema"))).toEqual([
      "  {",
      '-   "a": [1]',
      '+   "a": [2]',
      "  }",
    ]);
    expect(diffToolField(before, after, "title")).toEqual({
      kind: "inline",
      before: undefined,
      after: undefined,
    });
  });

  it("falls back to the legacy metadata field for meta", () => {
    const diff = diffToolField(
      { name: "t", metadata: { ui: "a" } },
      { name: "t", meta: { ui: "b" } },
      "meta",
    );
    expect(linesOf(diff)).toEqual([
      "  {",
      '-   "ui": "[a]"',
      '+   "ui": "[b]"',
      "  }",
    ]);
  });

  it("reads serverInfo fields from inside serverInfo", () => {
    expect(
      diffDiscoveryField(
        { serverInfo: { version: "4.1.2" } },
        { serverInfo: { version: "1.7.0" } },
        "serverInfo.version",
      ),
    ).toEqual({ kind: "inline", before: "4.1.2", after: "1.7.0" });
    expect(
      diffDiscoveryField(
        { instructions: "Call list_markets first." },
        { instructions: "Call list_markets before an order." },
        "instructions",
      ).kind,
    ).toBe("lines");
  });
});

describe("revisionMissing", () => {
  it("names the revision that dropped the path or a parent of it", () => {
    const from = { revisionNumber: 5, droppedFields: [] };
    const to = {
      revisionNumber: 6,
      droppedFields: ["discovery", "tools.t.inputSchema.$schema"],
    };
    expect(revisionMissing([from, to], "discovery.instructions")).toBe(6);
    expect(revisionMissing([from, to], "discovery")).toBe(6);
    expect(revisionMissing([from, to], "tools.t.inputSchema")).toBeUndefined();
    expect(revisionMissing([undefined, null], "discovery")).toBeUndefined();
  });
});
