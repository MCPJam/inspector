/**
 * Every kind of change a definition can carry, read by the climbs functions as
 * its own kind: who reads it, what it is called, where it sits in the mock.
 */
import { describe, expect, it } from "vitest";
import { diffMockDefinitions, type MockChange } from "../../mocks/change-list.js";
import { describePlace, mockPathOf } from "../../mocks/change-kinds.js";
import { checkKeptChanges } from "../listing-check.js";
import { climbPrompt } from "../prompt.js";
import { ALL_CLIENTS, fieldOfChange, readsOf, refuseUnreadChange, type ReadField } from "../client-reads.js";
import { whatCanChange } from "../what-can-change.js";

const definition = {
  prompts: { greet: { description: "Greets." } },
  resources: {
    "file:///notes.md": { text: "Notes." },
    "skill://triage/SKILL.md": { text: "---\nname: triage\n---" },
    "ui://card": { text: "<html></html>" },
  },
  resourceTemplates: { "file:///logs/{name}": { description: "A log." } },
} as never;
const changes = diffMockDefinitions({}, definition);
const by = (name: string) => changes.find((change) => change.name === name) as MockChange;

describe("each kind is its own kind", () => {
  it.each([
    ["greet", "prompt", 'the prompt "greet"', "prompts.greet.description"],
    ["file:///notes.md", "resource", 'the resource "file:///notes.md"', "resources.file:///notes.md.text"],
    ["skill://triage/SKILL.md", "skill", 'the skill file "skill://triage/SKILL.md"', "resources.skill://triage/SKILL.md.text"],
    ["ui://card", "app", 'the app "ui://card"', "resources.ui://card.text"],
    ["file:///logs/{name}", "resourceTemplate", 'the resource template "file:///logs/{name}"', "resourceTemplates.file:///logs/{name}.description"],
  ])("%s", (name, target, place, path) => {
    const change = by(name);
    expect(change.target).toBe(target);
    expect(describePlace(change)).toBe(place);
    expect(mockPathOf(change, change.details[0]!.path)).toBe(path);
  });
});

describe("who reads each kind", () => {
  it.each<[string, string, ReadField, string, string]>([
    // [name, path, field, mcpjam, harness client]
    ["greet", "description", "promptContent", "ignores", "unconfirmed"],
    ["file:///notes.md", "text", "resourceContent", "ignores", "unconfirmed"],
    ["file:///logs/{name}", "description", "templateContent", "ignores", "unconfirmed"],
    ["skill://triage/SKILL.md", "text", "skillContent", "ignores", "reads"],
    ["ui://card", "text", "appContent", "unconfirmed", "unconfirmed"],
  ])("%s at %s is %s", (name, path, field, mcpjam, harness) => {
    expect(fieldOfChange(by(name), path)).toBe(field);
    expect(readsOf("mcpjam", field)).toBe(mcpjam);
    expect(readsOf("claude-code", field)).toBe(harness);
  });

  it.each([
    ["a prompt", { prompts: { greet: { hidden: true } } }, "promptListing"],
    ["a resource", { resources: { "file:///a": { hidden: true } } }, "resourceListing"],
    ["a skill file", { resources: { "skill://x/SKILL.md": { hidden: true } } }, "skillListing"],
    ["an app", { resources: { "ui://x": { hidden: true } } }, "appListing"],
    ["a template", { resourceTemplates: { "file:///{a}": { hidden: true } } }, "templateListing"],
  ])("hiding %s changes what is listed", (_label, hidden, field) => {
    const [change] = diffMockDefinitions({}, hidden as never);
    expect(fieldOfChange(change!, "hidden")).toBe(field);
  });

  it("refuses a round of prompt edits for MCPJam's client alone, and lets a harness client read it", () => {
    const prompt = [by("greet")];
    expect(refuseUnreadChange(prompt, ["mcpjam"])?.unread[0]).toMatchObject({ field: "promptContent" });
    expect(refuseUnreadChange(prompt, ["mcpjam", "claude-code"])).toBeUndefined();
    expect(refuseUnreadChange([by("ui://card")], ["mcpjam"])).toBeUndefined();
    expect(ALL_CLIENTS).toContain("opencode");
  });
});

describe("the prompt for the coding agent", () => {
  it("names a prompt a prompt, and a tool of the same name a tool", () => {
    const text = climbPrompt({
      serverName: "Echo",
      kept: [{ number: 1, overruled: false, changes: [by("greet"), by("skill://triage/SKILL.md")] }],
    });
    expect(text).toContain('(description of the prompt "greet")');
    expect(text).toContain('(text of the skill file "skill://triage/SKILL.md")');
    expect(text).not.toContain('the tool "greet"');
  });
});

describe("what was tried, by place", () => {
  it("does not credit a prompt's round to a tool with the same name", () => {
    const entries = whatCanChange({
      server: { tools: [{ name: "greet", description: "Say hi." }] },
      clients: ["mcpjam"],
      tried: [{ round: 1, verdict: "kept", changes: [by("greet")] }],
    });
    expect(entries.every((entry) => entry.tried.length === 0)).toBe(true);
  });
});

describe("the listing check", () => {
  it("does not judge a prompt against the tools' listing", () => {
    const check = checkKeptChanges([by("greet")], { tools: [{ name: "greet", description: "Greets." }] });
    expect(check.changes).toEqual([]);
    expect(check.notChecked).toEqual(["prompts.greet.description"]);
  });
});
