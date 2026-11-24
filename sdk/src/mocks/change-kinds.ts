/**
 * Where each kind of change lives in a definition, and what a reader calls it.
 * One table, so the ranked list, the prompt, the listing check and the inverse
 * name a prompt a prompt and never a tool of the same name.
 */
import type { MockChange, MockChangeTarget } from "./change-list.js";

type Place = {
  /** The definition's map the entry sits in; the server's fields sit at the top. */
  map?: "tools" | "prompts" | "resources" | "resourceTemplates";
  /** How a sentence refers to it: `the prompt "name"`. */
  noun: string;
};

export const CHANGE_PLACES: Readonly<Record<MockChangeTarget, Place>> = {
  server: { noun: "the server" },
  tool: { map: "tools", noun: "the tool" },
  prompt: { map: "prompts", noun: "the prompt" },
  resource: { map: "resources", noun: "the resource" },
  resourceTemplate: { map: "resourceTemplates", noun: "the resource template" },
  // Skills and apps are `resources` entries, told apart by their address.
  skill: { map: "resources", noun: "the skill file" },
  app: { map: "resources", noun: "the app" },
};

/** The path of one field of a change in the definition: `prompts.<name>.description`. */
export function mockPathOf(change: MockChange, detailPath: string): string {
  const map = CHANGE_PLACES[change.target].map;
  return map === undefined ? detailPath : `${map}.${change.name ?? ""}.${detailPath}`;
}

/** Where a change is, as a reader says it: `the server`, `the tool "search"`, `the skill file "skill://x/SKILL.md"`. */
export function describePlace(change: MockChange): string {
  const { noun } = CHANGE_PLACES[change.target];
  return change.target === "server" ? noun : `${noun} "${change.name ?? ""}"`;
}
