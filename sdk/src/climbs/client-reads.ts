/**
 * What each client reads of a mock, and the refusal of a round that changes
 * only what no client in the climb reads.
 *
 * The table starts from the engineering spec's "What a mock carries" and is
 * kept by hand. A fact is `reads` or `ignores` when the spec states it or QA
 * measured it, and `unconfirmed` when it only says what a client is passed, not
 * what its model sees. Scenario V7 ran prompts, resources and skills on
 * MCPJam's own client and on Claude Code; the rest stay
 * unconfirmed until a run moves them. A refusal relies on `ignores` alone, so
 * an unconfirmed row never blocks a round.
 */
import type { MockChange } from "../mocks/change-list.js";
import type { ChangeReader, ClimbClient } from "./types.js";

export type ReadField =
  | "serverName"
  | "instructions"
  | "capabilities"
  | "toolListing"
  | "toolDescription"
  | "toolInputSchema"
  | "toolTitle"
  | "toolOutputSchema"
  | "toolAnnotations"
  | "toolIcons"
  | "toolMeta"
  | "toolResult"
  | "promptListing"
  | "promptContent"
  | "resourceListing"
  | "resourceContent"
  | "templateListing"
  | "templateContent"
  | "skillListing"
  | "skillContent"
  | "appListing"
  | "appContent";

/** When QA measured the rows V7 moved to `reads` or `ignores`. */
export const V7_CONFIRMATION = "confirmed by QA, 2026-11-24";

type Reads = ChangeReader["reads"];
const HARNESS: readonly ClimbClient[] = ["claude-code", "codex", "cursor", "copilot-cli", "opencode"];

/** The unconfirmed rows say why in `unconfirmedBecause`; V7 replaces each with a measured fact. */
const MCPJAM: Record<ReadField, Reads> = {
  // Read in Playground chat; no code was found that puts it in an eval's prompt.
  serverName: "unconfirmed",
  instructions: "unconfirmed",
  capabilities: "unconfirmed",
  toolListing: "reads",
  toolDescription: "reads",
  toolInputSchema: "reads",
  // "MCPJam's own client sends the model a tool's name, description and input schema."
  toolTitle: "ignores",
  toolOutputSchema: "ignores",
  toolAnnotations: "ignores",
  toolIcons: "ignores",
  toolMeta: "ignores",
  toolResult: "reads",
  // "Not in MCPJam's eval loop." Confirmed by QA (V7, an eval, 2
  // iterations each): a mock sent a prompt, a resource and a skill, and the
  // model reached none of them ("no tool to get prompts/resources/skills").
  promptListing: "ignores",
  promptContent: "ignores",
  resourceListing: "ignores",
  resourceContent: "ignores",
  templateListing: "ignores",
  templateContent: "ignores",
  // "MCPJam's client uses a pinned set in eval runs." Confirmed by QA (V7).
  skillListing: "ignores",
  skillContent: "ignores",
  // "Playground; eval widget steps": whether an eval's model-facing loop reads an app is what V7 measures.
  appListing: "unconfirmed",
  appContent: "unconfirmed",
};

const HARNESS_READS: Record<ReadField, Reads> = {
  // "Harness clients get instructions in the handshake."
  serverName: "unconfirmed",
  instructions: "reads",
  capabilities: "unconfirmed",
  toolListing: "reads",
  toolDescription: "reads",
  toolInputSchema: "reads",
  // "Passed to harness clients": whether the model sees them is what V7 measures.
  toolTitle: "unconfirmed",
  toolOutputSchema: "unconfirmed",
  toolAnnotations: "unconfirmed",
  toolIcons: "unconfirmed",
  toolMeta: "unconfirmed",
  toolResult: "reads",
  // "Passed to harness clients": only Claude Code was measured (see CLAUDE_CODE_READS).
  promptListing: "unconfirmed",
  promptContent: "unconfirmed",
  resourceListing: "unconfirmed",
  resourceContent: "unconfirmed",
  templateListing: "unconfirmed",
  templateContent: "unconfirmed",
  // "Harness clients, as host tools."
  skillListing: "reads",
  skillContent: "reads",
  // "Playground; eval widget steps": no harness client is named.
  appListing: "unconfirmed",
  appContent: "unconfirmed",
};

/**
 * What QA measured on Claude Code, over the harness defaults (V7, a chat turn
 * through a tunnel): the model quoted the mock's resource (through
 * its resource-reading tool) and its skill, and could not reach the prompt (no
 * tool lists prompts). Not run: listing a resource
 * or a template, and the other harness clients, which stay unconfirmed.
 */
const CLAUDE_CODE_READS: Partial<Record<ReadField, Reads>> = {
  promptListing: "ignores",
  promptContent: "ignores",
  resourceContent: "reads",
  skillListing: "reads",
  skillContent: "reads",
};

export const CLIENT_LABELS: Readonly<Record<ClimbClient, string>> = {
  mcpjam: "MCPJam's own client",
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "copilot-cli": "Copilot CLI",
  opencode: "OpenCode",
};

export function readsOf(client: ClimbClient, field: ReadField): Reads {
  if (client === "mcpjam") return MCPJAM[field];
  if (client === "claude-code") return CLAUDE_CODE_READS[field] ?? HARNESS_READS[field];
  return HARNESS_READS[field];
}

export function readersOf(field: ReadField, clients: readonly ClimbClient[]): ChangeReader[] {
  return clients.map((client) => ({ client, reads: readsOf(client, field) }));
}

/** Every client a mock's reach table covers, for a read that is not tied to a climb. */
export const ALL_CLIENTS: readonly ClimbClient[] = ["mcpjam", ...HARNESS];

/** The field one detail path of a change list touches. */
export function fieldOfChange(change: MockChange, path: string): ReadField {
  if (change.target === "server") {
    if (path.startsWith("serverInfo")) return "serverName";
    if (path.startsWith("instructions")) return "instructions";
    return "capabilities";
  }
  if (change.target !== "tool") {
    // Whatever the entry states, a reader of the item reads its content; only `hidden` changes what is listed.
    const listed = path.split(".")[0] === "hidden";
    switch (change.target) {
      case "prompt":
        return listed ? "promptListing" : "promptContent";
      case "resource":
        return listed ? "resourceListing" : "resourceContent";
      case "resourceTemplate":
        return listed ? "templateListing" : "templateContent";
      case "skill":
        return listed ? "skillListing" : "skillContent";
      case "app":
        return listed ? "appListing" : "appContent";
    }
  }
  // An entry added to the definition states fields of a tool the real server already lists, so
  // each detail is judged by its own path; only `hidden` changes what the listing holds.
  const head = path.split(".")[0] ?? "";
  switch (head) {
    case "description":
      return "toolDescription";
    case "inputSchema":
    case "params":
      return "toolInputSchema";
    case "title":
      return "toolTitle";
    case "outputSchema":
      return "toolOutputSchema";
    case "annotations":
      return "toolAnnotations";
    case "icons":
      return "toolIcons";
    case "_meta":
      return "toolMeta";
    case "hidden":
      return "toolListing";
    default:
      return "toolResult";
  }
}

export type UnreadRefusal = {
  refused: true;
  message: string;
  /** What the round changes, each with the clients that would read it. */
  unread: Array<{ summary: string; field: ReadField; wouldBeReadBy: ClimbClient[] }>;
};

/**
 * Refuses a round whose every change is a field that every client of the climb
 * ignores. A change with no detail rows counts by its target. Anything a client
 * reads, or may read, lets the round run.
 */
export function refuseUnreadChange(
  changes: readonly MockChange[],
  climbClients: readonly ClimbClient[],
): UnreadRefusal | undefined {
  if (changes.length === 0 || climbClients.length === 0) return undefined;
  const touched = changes.flatMap((change) =>
    (change.details.length > 0 ? change.details : [{ path: "", summary: change.summary }]).map((detail) => ({
      summary: detail.summary,
      field: fieldOfChange(change, detail.path),
    })),
  );
  const readByAClient = touched.some(({ field }) => climbClients.some((client) => readsOf(client, field) !== "ignores"));
  if (readByAClient) return undefined;
  const unread = touched.map(({ summary, field }) => ({
    summary,
    field,
    wouldBeReadBy: ALL_CLIENTS.filter((client) => readsOf(client, field) !== "ignores"),
  }));
  const ignoring = climbClients.map((client) => CLIENT_LABELS[client]).join(" and ");
  const readers = [...new Set(unread.flatMap((entry) => entry.wouldBeReadBy))].map((client) => CLIENT_LABELS[client]);
  return {
    refused: true,
    unread,
    message:
      `No client in this climb reads what this round changes (${unread.map((entry) => entry.summary).join("; ")}). ` +
      `${ignoring} ${climbClients.length > 1 ? "do not" : "does not"} send it to the model, so the round would measure nothing. ` +
      (readers.length > 0
        ? `${readers.join(", ")} would read it: add an environment that runs one, or change a field every client reads, such as a tool's description or input schema.`
        : "Change a field every client reads, such as a tool's description or input schema."),
  };
}
