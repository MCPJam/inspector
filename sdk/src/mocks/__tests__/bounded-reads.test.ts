import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/server";
import {
  MOCK_READ_LIMIT,
  MOCK_TEXT_BUDGET,
  MockCursorError,
  applyFieldEdit,
  changeEntries,
  chunkText,
  findBindingIssues,
  openMockCursor,
  readMockView,
  sealMockCursor,
  textSize,
  type MockDefinition,
  type MockReadSelector,
} from "../index.js";

/** A generated server of `count` tools; each description is a few sentences. */
function manyTools(count: number): Tool[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `tool_${String(i + 1).padStart(3, "0")}`,
    description: `Tool number ${i + 1}. ${"It does one thing well and says so at length. ".repeat(4)}`,
    inputSchema: {
      type: "object" as const,
      properties: { query: { type: "string", description: `Query for tool ${i + 1}` } },
      required: ["query"],
    },
  }));
}

const tools = manyTools(202);
const LAST = "tool_202";
const definition: MockDefinition = {
  instructions: "Use the tools.",
  tools: {
    tool_001: { description: "First, changed." },
    [LAST]: { hidden: true },
  },
};

function host(offset = 0, envelope: Record<string, unknown> = {}) {
  return { offset, envelope, seal: (o: number) => `cursor-${o}` };
}

function readAll(selector: MockReadSelector, def = definition) {
  const pages: Record<string, any>[] = [];
  let offset = 0;
  for (;;) {
    const page = readMockView({ definition: def, listing: { tools } }, selector, host(offset)) as Record<string, any>;
    pages.push(page);
    if (page.page.end) return pages;
    offset = Number(String(page.page.nextCursor).replace("cursor-", ""));
  }
}

describe("bounded reads of a 202-tool mock", () => {
  it("counts a change as one entry or one server-wide setting", () => {
    const changes = changeEntries({
      ...definition,
      serverInfo: { name: "x", version: "1" },
      tools: { a: { description: "d", params: { q: { fixed: 1 } } } },
    });
    expect(changes.map((c) => c.path)).toEqual(["instructions", "serverInfo", "tools.a"]);
    expect(changes[2]?.fields).toEqual(["description", "params.q.fixed"]);
  });

  it("lists every tool in pages that each fit the budget and end explicitly", () => {
    const pages = readAll({ family: "tools" });
    expect(pages.length).toBeGreaterThan(1);
    const names = pages.flatMap((p) => p.entries.map((e: { name: string }) => e.name));
    expect(names).toHaveLength(202);
    for (const p of pages) expect(textSize(p)).toBeLessThanOrEqual(MOCK_READ_LIMIT);
    expect(pages.at(-1)?.page).toMatchObject({ end: true, total: 202 });
    expect(pages.at(-1)?.page.nextCursor).toBeUndefined();
    expect(pages[0]?.page.nextCursor).toBeDefined();
  });

  it("finds the last tool by name and by search, and says it is hidden and edited", () => {
    const [found] = readAll({ family: "tools", search: "202" });
    expect(found?.entries).toEqual([expect.objectContaining({ name: LAST, kind: "edited", hidden: true })]);
    const entry = readMockView({ definition, listing: { tools } }, { family: "tools", name: LAST }, host()) as Record<string, any>;
    expect(entry).toMatchObject({ view: "entry", name: LAST, kind: "edited", stated: { hidden: true } });
    expect(entry.effective.description).toContain("Tool number 202");
  });

  it("reads one field, and a nested path, of an entry that is only the real server's", () => {
    const view = readMockView({ definition, listing: { tools } }, { family: "tools", name: "tool_150", path: ["inputSchema", "properties", "query", "description"] }, host()) as Record<string, any>;
    expect(view).toMatchObject({ value: "Query for tool 150", stated: false });
    expect(readMockView({ definition, listing: { tools } }, { family: "tools", name: "tool_150", path: ["nope"] }, host())).toBeUndefined();
  });

  it("reconstructs an oversized string across chunks without loss", () => {
    const awkward = `${'quote " back \\ line\n tab\t ctl\u0001 emoji 😀 '.repeat(2500)}end`;
    const def: MockDefinition = { tools: { [LAST]: { description: awkward } } };
    const pages = readAll({ family: "tools", name: LAST, path: ["description"] }, def);
    expect(pages.length).toBeGreaterThan(5);
    for (const p of pages) expect(textSize(p)).toBeLessThanOrEqual(MOCK_READ_LIMIT);
    expect(pages.map((p) => p.value).join("")).toBe(awkward);
    expect(pages.at(-1)?.page).toMatchObject({ end: true, total: awkward.length, unit: "characters" });
  });

  it("never splits a surrogate pair", () => {
    const text = "😀".repeat(100);
    let offset = 0;
    let out = "";
    while (offset < text.length) {
      const { chunk, end } = chunkText(text, offset, 7);
      out += chunk;
      expect(chunk.length % 2).toBe(0);
      offset = end;
    }
    expect(out).toBe(text);
  });

  it("marks long values in an entry with the path to read them", () => {
    const def: MockDefinition = { tools: { [LAST]: { description: "x".repeat(50_000) } } };
    const entry = readMockView({ definition: def, listing: { tools } }, { family: "tools", name: LAST }, host()) as Record<string, any>;
    expect(entry.stated.description).toEqual({ $omitted: "string", length: 50_000, path: ["description"] });
    expect(textSize(entry)).toBeLessThanOrEqual(MOCK_READ_LIMIT);
    expect(MOCK_READ_LIMIT).toBeLessThan(MOCK_TEXT_BUDGET);
  });
});

describe("cursors", () => {
  const binding = { scope: "user-1:mock-1", query: { family: "tools" } };
  it("round-trips the version and offset", () => {
    expect(openMockCursor(sealMockCursor({ version: 3, offset: 40 }, binding), binding)).toEqual({ version: 3, offset: 40 });
  });
  it("refuses another caller, another query and a made-up cursor", () => {
    const cursor = sealMockCursor({ version: 3, offset: 40 }, binding);
    const refusal = (b: typeof binding, c = cursor) => {
      try {
        openMockCursor(c, b);
      } catch (error) {
        return (error as MockCursorError).reason;
      }
      return undefined;
    };
    expect(refusal({ ...binding, scope: "user-2:mock-1" })).toBe("other_caller");
    expect(refusal({ ...binding, query: { family: "prompts" } })).toBe("other_query");
    expect(refusal(binding, "not-a-cursor")).toBe("malformed");
  });
});

describe("field edits", () => {
  it("sets one nested path without touching the rest", () => {
    const result = applyFieldEdit(definition, { family: "tools", name: LAST, path: ["description"], value: "New." });
    expect(result).toMatchObject({ ok: true, path: ["tools", LAST, "description"] });
    expect((result as { definition: MockDefinition }).definition.tools?.[LAST]).toEqual({ hidden: true, description: "New." });
    expect(definition.tools?.[LAST]).toEqual({ hidden: true });
  });
  it("removes a path and drops entries it leaves empty", () => {
    const result = applyFieldEdit({ tools: { a: { description: "d" } } }, { family: "tools", name: "a", path: ["description"], remove: true });
    expect((result as { definition: MockDefinition }).definition).toEqual({});
  });
  it("refuses unclear edits by saying what to give", () => {
    expect(applyFieldEdit({}, { name: "a", value: 1 })).toMatchObject({ ok: false });
    expect(applyFieldEdit({}, { path: ["a"] })).toMatchObject({ ok: false });
    expect(applyFieldEdit({}, { path: ["__proto__"], value: 1 })).toMatchObject({ ok: false });
    expect(applyFieldEdit({ instructions: "x" }, { path: ["instructions", "a"], value: 1 })).toMatchObject({ ok: false });
  });
});

describe("binding issues", () => {
  const real: Tool[] = [
    { name: "search", inputSchema: { type: "object", properties: { q: { type: "string" }, n: { type: "integer" } }, required: ["q"] } },
  ];
  it("names the override path for a missing target, a gone parameter, a hidden required one and a wrong type", () => {
    const issues = findBindingIssues(
      {
        tools: {
          find: { answer: { tool: "lookup" } },
          search: { params: { gone: { hidden: true }, q: { hidden: true }, n: { fixed: "ten" } } },
          saved: { answer: { from: "saved", cases: [{ result: { content: [] } }] } },
        },
      },
      real
    );
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ["tools.find.answer.tool", "target_missing"],
      ["tools.search.params.gone", "param_missing"],
      ["tools.search.params.q", "param_required"],
      ["tools.search.params.n.fixed", "value_incompatible"],
    ]);
  });
});
