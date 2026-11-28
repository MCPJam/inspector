/**
 * Where each kind of change lives in a definition. One table, so the change
 * list names a prompt a prompt and never a tool of the same name, and a path
 * it prints is the path a patch takes.
 */
import type { MockChange, MockChangeTarget } from "./change-list.js";

type Place = {
  /** The definition's map the entry sits in; the server's fields sit at the top. */
  map?: "tools" | "prompts" | "resources" | "resourceTemplates";
};

export const CHANGE_PLACES: Readonly<Record<MockChangeTarget, Place>> = {
  server: {},
  tool: { map: "tools" },
  prompt: { map: "prompts" },
  resource: { map: "resources" },
  resourceTemplate: { map: "resourceTemplates" },
  // Skills and apps are `resources` entries, told apart by their address.
  skill: { map: "resources" },
  app: { map: "resources" },
};

/** The path of one field of a change in the definition: `prompts.<name>.description`. */
export function mockPathOf(change: MockChange, detailPath: string): string {
  const map = CHANGE_PLACES[change.target].map;
  return map === undefined ? detailPath : `${map}.${change.name ?? ""}.${detailPath}`;
}
