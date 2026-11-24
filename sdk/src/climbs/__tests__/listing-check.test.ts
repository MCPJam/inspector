import { describe, expect, it } from "vitest";
import { diffMockDefinitions } from "../../mocks/change-list.js";
import { checkKeptChanges, maskKeptFields } from "../listing-check.js";

const KEPT = diffMockDefinitions({}, { tools: { search: { description: "Search the index." } }, instructions: "Be brief." } as never);
const OLD = { instructions: "Use the tools.", tools: { search: { description: "Find things." } } };
const listing = (description: string, instructions?: string) => ({
  instructions,
  tools: [{ name: "search", description }],
});

describe("checkKeptChanges", () => {
  it("names a change applied when the server lists the kept value", () => {
    const check = checkKeptChanges(KEPT, listing("Search the index.", "Be brief."), OLD);
    expect(check).toMatchObject({ allApplied: true, applied: 2, missing: 0, different: 0 });
  });

  it("names it missing when the server still lists the old value, before anything is applied", () => {
    const check = checkKeptChanges(KEPT, listing("Find things.", "Use the tools."), OLD);
    expect(check).toMatchObject({ allApplied: false, missing: 2 });
    expect(check.changes[0]).toMatchObject({ path: "instructions", status: "missing", expected: "Be brief.", actual: "Use the tools." });
  });

  it("names it different when the server lists a third wording", () => {
    const check = checkKeptChanges(KEPT, listing("Look things up.", "Be brief."), OLD);
    expect(check.changes.find((entry) => entry.path === "tools.search.description")).toMatchObject({ status: "different", actual: "Look things up." });
  });

  it("says different, never missing, when the old value is not known", () => {
    expect(checkKeptChanges(KEPT, listing("Find things.", "Be brief.")).changes.find((entry) => entry.path === "tools.search.description")!.status).toBe("different");
  });

  it("applies a hidden tool when the server no longer lists it, and counts a rename as not judged", () => {
    const hidden = diffMockDefinitions({}, { tools: { search: { hidden: true }, find: { answer: { tool: "search" } } } } as never);
    const check = checkKeptChanges(hidden, { tools: [] });
    expect(check.changes).toEqual([expect.objectContaining({ path: "tools.search.hidden", status: "applied" })]);
    expect(check.notChecked).toEqual(["tools.find.answer.tool"]);
    expect(checkKeptChanges(hidden, { tools: [{ name: "search" }] }).changes[0]!.status).toBe("missing");
  });
});

describe("maskKeptFields", () => {
  it("nulls the fields the kept changes touched and leaves the rest, so a hash of it sees only other changes", () => {
    const tools = [{ name: "search", description: "a", title: "T" }, { name: "fetch", description: "b" }];
    expect(maskKeptFields(tools, KEPT)).toEqual([{ name: "search", description: null, title: "T" }, { name: "fetch", description: "b" }]);
    const changed = [{ name: "search", description: "other", title: "T2" }, tools[1]!];
    expect(JSON.stringify(maskKeptFields(changed, KEPT))).not.toEqual(JSON.stringify(maskKeptFields(tools, KEPT)));
  });
});
