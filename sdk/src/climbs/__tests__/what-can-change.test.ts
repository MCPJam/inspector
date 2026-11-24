import { describe, expect, it } from "vitest";
import { whatCanChange } from "../what-can-change.js";
import { evidence } from "./fixtures.js";
import type { RealServerView } from "../types.js";

const SERVER: RealServerView = {
  serverInfo: { name: "Echo" },
  instructions: "Use the tools.",
  tools: [
    { name: "search", description: "Find things.", inputSchema: { type: "object", properties: { query: { type: "string", description: "What to find" } } } },
    { name: "fetch", description: "Get one.", inputSchema: { type: "object", properties: {} } },
  ],
};

const at = (entries: ReturnType<typeof whatCanChange>, path: string) => entries.find((entry) => entry.where.mockPath === path)!;

describe("whatCanChange", () => {
  it("lists every place a mock can change, with the real value and a path an update can use", () => {
    const entries = whatCanChange({ server: SERVER, clients: ["mcpjam", "claude-code"] });
    expect(at(entries, "tools.search.description")).toMatchObject({ current: "Find things.", where: { kind: "tool", tool: "search", field: "description" } });
    expect(at(entries, "tools.search.params.query.description")).toMatchObject({ current: "What to find", where: { kind: "param", param: "query" } });
    expect(at(entries, "instructions").current).toBe("Use the tools.");
    expect(at(entries, "tools.fetch.hidden").current).toBe(false);
    expect(entries.map((entry) => entry.rank)).toEqual(entries.map((_, index) => index + 1));
  });

  it("says who reads each field, from the table, for the climb's own clients", () => {
    const entries = whatCanChange({ server: SERVER, clients: ["mcpjam", "claude-code"] });
    expect(at(entries, "tools.search.description").readBy).toEqual([
      { client: "mcpjam", reads: "reads" },
      { client: "claude-code", reads: "reads" },
    ]);
    expect(at(entries, "tools.search.title").readBy).toEqual([
      { client: "mcpjam", reads: "ignores" },
      { client: "claude-code", reads: "unconfirmed" },
    ]);
  });

  it("puts what failed runs point at first, with those runs", () => {
    const entries = whatCanChange({
      server: SERVER,
      clients: ["mcpjam"],
      evidence: [
        evidence({ iterationId: "a", tool: "search", failureCategory: "selection" }),
        evidence({ iterationId: "b", caseKey: "other", tool: "search", failureCategory: "selection" }),
        evidence({ iterationId: "c", tool: "fetch", failureCategory: "arguments" }),
      ],
    });
    expect(entries[0]!.where.mockPath).toBe("tools.search.description");
    expect(entries[0]).toMatchObject({ failedIterations: 2 });
    expect(entries[0]!.failedRuns.map((failed) => failed.iterationId)).toEqual(["a", "b"]);
    expect(at(entries, "tools.fetch.inputSchema").failedIterations).toBe(1);
  });

  it("sorts what no client of the climb reads last, and marks it", () => {
    const entries = whatCanChange({ server: SERVER, clients: ["mcpjam"] });
    const title = at(entries, "tools.search.title");
    expect(title.readByAnyClient).toBe(false);
    expect(entries.at(-1)!.readByAnyClient).toBe(false);
    expect(entries.findIndex((entry) => entry.where.mockPath === "tools.search.description")).toBeLessThan(entries.indexOf(title));
  });

  it("records what was tried at a place, whatever depth the round changed it at", () => {
    const entries = whatCanChange({
      server: SERVER,
      clients: ["mcpjam"],
      tried: [
        {
          round: 2,
          verdict: "reverted",
          changes: [{ target: "tool", name: "search", kind: "changed", summary: "x", details: [{ path: "description", kind: "changed", summary: "y" }] }],
        },
        {
          round: 3,
          verdict: "kept",
          changes: [{ target: "tool", name: "search", kind: "changed", summary: "x", details: [{ path: "params.query.description", kind: "changed", summary: "y" }] }],
        },
      ],
    });
    expect(at(entries, "tools.search.description").tried).toEqual([{ round: 2, verdict: "reverted" }]);
    expect(at(entries, "tools.search.params.query.description").tried).toEqual([{ round: 3, verdict: "kept" }]);
    expect(at(entries, "tools.fetch.description").tried).toEqual([]);
  });
});
