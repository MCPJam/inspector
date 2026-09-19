/**
 * Navigation from a finding to what it cites goes through a TYPED locator.
 *
 * A caller receives `{ kind: "iteration", id }` or `{ kind: "session", id }`
 * and routes it with its own knowledge of its own routes — the panel never
 * inspects the shape of an id to guess which one it is.
 */
export type FindingEvidenceLocator =
  | { kind: "iteration"; id: string }
  | { kind: "session"; id: string };
