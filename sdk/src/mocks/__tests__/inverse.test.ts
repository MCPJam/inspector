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

describe("inverseOfChanges for prompts, resources, templates, skills and apps", () => {
  const OLD_ITEMS: OldServer = {
    ...OLD,
    prompts: { greet: { description: "Says hello.", title: "Greet" } },
    resources: {
      "file:///notes.md": { description: "Notes.", mimeType: "text/markdown" },
      "skill://triage/SKILL.md": { text: "old skill text" },
      "ui://card": { description: "A card.", _meta: { ui: { csp: {} } } },
    },
    resourceTemplates: { "file:///logs/{name}": { description: "A log." } },
  };

  it.each([
    ["a prompt's description", { prompts: { greet: { description: "Hello!" } } }, { prompts: { greet: { description: "Says hello." } } }],
    ["a resource's description", { resources: { "file:///notes.md": { description: "New." } } }, { resources: { "file:///notes.md": { description: "Notes." } } }],
    ["a template's description", { resourceTemplates: { "file:///logs/{name}": { description: "New." } } }, { resourceTemplates: { "file:///logs/{name}": { description: "A log." } } }],
    ["a skill file's text", { resources: { "skill://triage/SKILL.md": { text: "new" } } }, { resources: { "skill://triage/SKILL.md": { text: "old skill text" } } }],
    ["an app's meta", { resources: { "ui://card": { _meta: { ui: { csp: { a: 1 } } } } } }, { resources: { "ui://card": { _meta: { ui: { csp: {} } } } } }],
  ])("puts back %s", (_label, definition, expected) => {
    const inverse = inverseOfChanges(kept(definition), OLD_ITEMS);
    expect(inverse.unrestorable).toEqual([]);
    expect(inverse.definition).toEqual(expected);
  });

  it("hides again an entry the kept change showed again, and states nothing else for it", () => {
    const before = { prompts: { greet: { hidden: true as const } }, resources: { "ui://card": { hidden: true as const } } };
    const after = { prompts: { greet: { description: "Hello!" } }, resources: { "ui://card": { description: "x" } } };
    const inverse = inverseOfChanges(diffMockDefinitions(before as never, after as never), OLD_ITEMS);
    expect(inverse.unrestorable).toEqual([]);
    expect(inverse.definition).toEqual({ prompts: { greet: { hidden: true } }, resources: { "ui://card": { hidden: true } } });
  });

  it.each([
    ["an entry the new code removed", { prompts: { greet: { hidden: true } } }, "prompts.greet.hidden", /removed the prompt "greet"/],
    ["an entry that did not exist", { prompts: { fresh: { description: "x" } } }, "prompts.fresh.description", /did not exist before/],
    ["a field the old entry did not have", { prompts: { greet: { arguments: [{ name: "a" }] } } }, "prompts.greet.arguments", /cannot take a field away/],
    ["a kind the capture did not store", { resources: { "file:///other": { description: "x" } } }, "resources.file:///other.description", /did not exist before/],
    ["a skill the capture did not store", { resources: { "skill://x/SKILL.md": { text: "x" } } }, "resources.skill://x/SKILL.md.text", /did not exist before/],
  ])("cannot put back %s, and says why", (_label, definition, path, why) => {
    const inverse = inverseOfChanges(kept(definition), OLD_ITEMS);
    expect(inverse.unrestorable.find((entry) => entry.path === path)?.why).toMatch(why);
    expect(inverse.definition.prompts).toBeUndefined();
  });

  it("says the old value was not stored when the capture holds no such map", () => {
    const inverse = inverseOfChanges(kept({ prompts: { greet: { description: "x" } } }), OLD);
    expect(inverse.unrestorable[0]).toMatchObject({ path: "prompts.greet.description", why: expect.stringContaining("was not stored") });
  });
});
