import { describe, expect, it } from "vitest";
import type { MockChange } from "../../mocks/change-list.js";
import { fieldOfChange, readsOf, refuseUnreadChange } from "../client-reads.js";

const toolChange = (path: string, kind: MockChange["kind"] = "changed"): MockChange => ({
  target: "tool",
  name: "search",
  kind,
  summary: `Changed ${path} of "search"`,
  details: [{ path, kind, summary: `Changed ${path}` }],
});

describe("what each client reads", () => {
  it.each([
    ["mcpjam", "toolDescription", "reads"],
    ["mcpjam", "toolInputSchema", "reads"],
    ["mcpjam", "toolTitle", "ignores"],
    ["mcpjam", "toolOutputSchema", "ignores"],
    ["mcpjam", "instructions", "unconfirmed"],
    ["claude-code", "instructions", "reads"],
    ["claude-code", "toolTitle", "unconfirmed"],
    ["codex", "toolDescription", "reads"],
  ] as const)("%s and %s: %s", (client, field, expected) => {
    expect(readsOf(client, field)).toBe(expected);
  });

  it.each([
    [["description"], "toolDescription"],
    [["params.limit.fixed"], "toolInputSchema"],
    [["inputSchema.properties"], "toolInputSchema"],
    [["title"], "toolTitle"],
    [["outputSchema"], "toolOutputSchema"],
    [["annotations.destructiveHint"], "toolAnnotations"],
    [["answer.tool"], "toolResult"],
    [["hidden"], "toolListing"],
  ] as const)("a change at %s is the field %s", ([path], field) => {
    expect(fieldOfChange(toolChange(path), path)).toBe(field);
  });

  it("judges an entry added to the definition by the fields it states, and a server change by its path", () => {
    expect(fieldOfChange(toolChange("description", "added"), "description")).toBe("toolDescription");
    expect(fieldOfChange(toolChange("hidden", "added"), "hidden")).toBe("toolListing");
    const server = (path: string): MockChange => ({ target: "server", kind: "changed", summary: "s", details: [{ path, kind: "changed", summary: "s" }] });
    expect(fieldOfChange(server("serverInfo.name"), "serverInfo.name")).toBe("serverName");
    expect(fieldOfChange(server("instructions"), "instructions")).toBe("instructions");
    expect(fieldOfChange(server("capabilities.tools"), "capabilities.tools")).toBe("capabilities");
  });
});

describe("refuseUnreadChange", () => {
  it("refuses a round that changes only a title when the only client ignores it, and names who would read it", () => {
    const refusal = refuseUnreadChange([toolChange("title")], ["mcpjam"]);
    expect(refusal?.refused).toBe(true);
    expect(refusal?.message).toContain("No client in this climb reads what this round changes");
    expect(refusal?.message).toContain("MCPJam's own client does not send it to the model");
    expect(refusal?.message).toContain("Claude Code");
    expect(refusal?.unread[0]).toMatchObject({ field: "toolTitle", wouldBeReadBy: expect.arrayContaining(["claude-code", "codex"]) });
  });

  it.each([
    ["a description beside a title", [toolChange("title"), toolChange("description")], ["mcpjam"]],
    ["a title when a harness client may read it", [toolChange("title")], ["mcpjam", "claude-code"]],
    ["an instructions change, which is unconfirmed", [{ target: "server", kind: "changed", summary: "s", details: [{ path: "instructions", kind: "changed", summary: "s" }] } as MockChange], ["mcpjam"]],
    ["a change that has no climb to judge it by", [toolChange("title")], []],
    ["no change at all", [], ["mcpjam"]],
  ])("lets through %s", (_label, changes, clients) => {
    expect(refuseUnreadChange(changes, clients as never)).toBeUndefined();
  });
});
