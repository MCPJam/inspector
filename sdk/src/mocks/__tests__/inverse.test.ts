import { describe, expect, it } from "vitest";
import { diffMockDefinitions } from "../change-list.js";
import { inverseOfChanges, type OldServer } from "../inverse.js";

const OLD: OldServer = {
  instructions: "Use the tools.",
  tools: {
    search: {
      description: "Find things.",
      title: "Search",
      inputSchema: { type: "object", properties: { query: { type: "string" }, lang: { type: "string" } } },
    },
    fetch: { description: "Get one." },
  },
};
const kept = (definition: object) => diffMockDefinitions({}, definition as never);

describe("inverseOfChanges", () => {
  it("states the old value of every field a kept change touched", () => {
    const inverse = inverseOfChanges(
      kept({ instructions: "Be brief.", tools: { search: { description: "Search the index.", title: "Index search" } } }),
      OLD,
    );
    expect(inverse.unrestorable).toEqual([]);
    expect(inverse.definition).toEqual({
      instructions: "Use the tools.",
      tools: { search: { description: "Find things.", title: "Search" } },
    });
  });

  it("puts the whole old input schema back for a hidden or fixed parameter", () => {
    const inverse = inverseOfChanges(kept({ tools: { search: { params: { lang: { fixed: "en" } } } } }), OLD);
    expect(inverse.definition).toEqual({ tools: { search: { inputSchema: OLD.tools.search!.inputSchema } } });
    expect(inverse.unrestorable).toEqual([]);
  });

  it.each([
    ["a tool the new code removed", { tools: { fetch: { hidden: true } } }, "tools.fetch.hidden", /removed the tool "fetch"/],
    ["a rename", { tools: { find: { answer: { tool: "search" } } } }, "tools.find.answer.tool", /did not exist before/],
    ["a field the old tool did not have", { tools: { fetch: { title: "Fetch" } } }, "tools.fetch.title", /cannot take a field away/],
    ["an old value storage dropped", { tools: { search: { description: "x" } } }, "tools.search.description", /was not stored/],
  ])("cannot put back %s, and says why", (_label, definition, path, why) => {
    const old = path === "tools.search.description" ? { ...OLD, droppedFields: ["tools.search.description"] } : OLD;
    const inverse = inverseOfChanges(kept(definition), old);
    expect(inverse.unrestorable.map((entry) => entry.path)).toContain(path);
    expect(inverse.unrestorable.find((entry) => entry.path === path)!.why).toMatch(why);
    expect(inverse.definition.tools?.[path.split(".")[1]!]).toBeUndefined();
  });

  it("restores what it can and lists the rest", () => {
    const inverse = inverseOfChanges(kept({ tools: { search: { description: "x" }, fetch: { hidden: true } } }), OLD);
    expect(inverse.definition.tools).toEqual({ search: { description: "Find things." } });
    expect(inverse.unrestorable).toHaveLength(1);
  });
});
