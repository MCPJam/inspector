import { describe, expect, it } from "vitest";
import { canDraft, changeValue, entryLabel, fieldKind, initialText, mergePatch, patchFor } from "../change-model";

const entry = (where: object, current: unknown = "") =>
  ({ rank: 1, where, current, readBy: [], readByAnyClient: true, failedIterations: 0, failedRuns: [], tried: [] }) as never;

const description = entry({ kind: "tool", tool: "list_projects", field: "description", mockPath: "tools.list_projects.description" }, "List projects.");
const param = entry({ kind: "param", tool: "list_projects", param: "project_id", field: "params.description", mockPath: "x" });
const instructions = entry({ kind: "server", field: "instructions", mockPath: "instructions" });
const serverName = entry({ kind: "server", field: "serverInfo.name", mockPath: "serverInfo.name" });
const hidden = entry({ kind: "tool", tool: "show_servers", field: "hidden", mockPath: "x" }, false);
const schema = entry({ kind: "tool", tool: "list_projects", field: "inputSchema", mockPath: "x" }, { type: "object" });

describe("fieldKind and labels", () => {
  it("is text for words, hidden for visibility and JSON for the rest", () => {
    expect([description, param, instructions, serverName].map(fieldKind)).toEqual(["text", "text", "text", "text"]);
    expect(fieldKind(hidden)).toBe("hidden");
    expect(fieldKind(schema)).toBe("json");
  });
  it("names where a change goes", () => {
    expect(entryLabel(description)).toEqual({ name: "list_projects", field: "description" });
    expect(entryLabel(param)).toEqual({ name: "list_projects", field: "parameter project_id description" });
    expect(entryLabel(instructions)).toEqual({ name: "The server", field: "instructions" });
  });
  it("starts the text at the current value", () => {
    expect(initialText(description)).toBe("List projects.");
    expect(initialText(schema)).toBe('{\n  "type": "object"\n}');
    expect(initialText(entry({ kind: "server", field: "instructions", mockPath: "i" }, undefined))).toBe("");
  });
});

describe("changeValue", () => {
  it("refuses empty text and invalid JSON in words, and takes what is valid", () => {
    expect(changeValue(description, "  ", true)).toMatchObject({ ok: false });
    expect(changeValue(schema, "{nope", true)).toMatchObject({ ok: false, error: expect.stringContaining("not valid JSON") });
    expect(changeValue(schema, '{"type":"string"}', true)).toEqual({ ok: true, value: { type: "string" } });
    expect(changeValue(description, "Lists them.", true)).toEqual({ ok: true, value: "Lists them." });
    expect(changeValue(hidden, "", true)).toEqual({ ok: true, value: true });
  });
});

describe("patchFor and mergePatch", () => {
  it("builds the merge patch of each kind of change", () => {
    expect(patchFor(description, "X")).toEqual({ tools: { list_projects: { description: "X" } } });
    expect(patchFor(param, "X")).toEqual({ tools: { list_projects: { params: { project_id: { description: "X" } } } } });
    expect(patchFor(instructions, "X")).toEqual({ instructions: "X" });
    expect(patchFor(serverName, "X")).toEqual({ serverInfo: { name: "X" } });
    expect(patchFor(hidden, true)).toEqual({ tools: { show_servers: { hidden: true } } });
  });
  it("changes one thing and keeps the rest of the definition (RFC 7396)", () => {
    const base = { tools: { list_projects: { description: "old", title: "T" }, other: { hidden: true } }, instructions: "i" };
    expect(mergePatch(base, patchFor(description, "new"))).toEqual({
      tools: { list_projects: { description: "new", title: "T" }, other: { hidden: true } },
      instructions: "i",
    });
    expect(base.tools.list_projects.description).toBe("old");
  });
  it("removes a key set to null and builds a missing branch", () => {
    expect(mergePatch({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
    expect(mergePatch({}, { tools: { x: { description: "d" } } })).toEqual({ tools: { x: { description: "d" } } });
    expect(mergePatch({ a: [1] }, { a: [2] })).toEqual({ a: [2] });
  });
});

describe("canDraft", () => {
  it("drafts a tool's description or title when a steering case calls the tool", () => {
    expect(canDraft(description, ["list_projects"])).toBe(true);
    expect(canDraft(description, ["other"])).toBe(false);
    expect(canDraft(instructions, ["list_projects"])).toBe(false);
    expect(canDraft(param, ["list_projects"])).toBe(false);
  });
});
