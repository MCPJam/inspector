import { describe, expect, it } from "vitest";
import type { MockChange } from "../../mocks/change-list.js";
import { V7_CONFIRMATION, fieldOfChange, readsOf, refuseUnreadChange } from "../client-reads.js";

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
    // V7 (see V7_CONFIRMATION).
    ["mcpjam", "promptContent", "ignores"],
    ["mcpjam", "resourceContent", "ignores"],
    ["mcpjam", "skillContent", "ignores"],
    ["claude-code", "resourceContent", "reads"],
    ["claude-code", "skillContent", "reads"],
    ["claude-code", "promptContent", "ignores"],
    ["claude-code", "promptListing", "ignores"],
    ["claude-code", "resourceListing", "unconfirmed"],
    ["codex", "promptContent", "unconfirmed"],
    ["codex", "resourceContent", "unconfirmed"],
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

  it("records when QA measured the confirmed rows", () => {
    expect(V7_CONFIRMATION).toBe("confirmed by QA, 2026-11-24");
  });

  it("refuses a prompt-only round when the climb runs MCPJam's client and Claude Code, and not once a client that may read it joins", () => {
    const prompt: MockChange = {
      target: "prompt",
      name: "summarize",
      kind: "changed",
      summary: "Changed the prompt summarize",
      details: [{ path: "template", kind: "changed", summary: "Changed template" }],
    };
    expect(refuseUnreadChange([prompt], ["mcpjam", "claude-code"])?.refused).toBe(true);
    expect(refuseUnreadChange([prompt], ["mcpjam", "codex"])).toBeUndefined();
    const resource: MockChange = { ...prompt, target: "resource", summary: "Changed a resource" };
    expect(refuseUnreadChange([resource], ["mcpjam", "claude-code"])).toBeUndefined();
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
