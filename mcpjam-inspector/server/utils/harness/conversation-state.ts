/**
 * Where each harness runtime keeps the conversation it resumes from, on its
 * box. A turn on a REPLACED box gets these files back before the CLI starts
 * and resumes natively (`session-snapshot/`); the save, the restore and the
 * paths they accept read this and nothing else about a runtime.
 *
 * A declaration names conversation files only: never the working folder, the
 * CLI's config or its credentials. A runtime is declared once a box
 * replacement with exactly these files is shown to resume it; `null` means
 * its conversation does not survive a replaced box.
 *
 * Paths are relative to the box's home, so a new box with the same harness
 * session puts them back in the same place. Two placeholders expand, each to
 * an id that must be a plain name or nothing is saved:
 *
 *   - `{sessionData}`: MCPJam's folder for the harness session
 *     (`.ai-sdk-harness/.agent-runs/<harness session id>`);
 *   - `{id}`: the CLI's own id for the session, read from `idKey`.
 */
import type { Harness } from "@mcpjam/sdk/host-config/internal";

export interface HarnessConversationState {
  /** Where the CLI's own session id sits in its resume state's `data`. */
  idKey?: string;
  /** The folder holding the conversation. Nothing outside it is saved or restored. */
  folder: string;
  /**
   * Save only the entries this many levels below `folder` with one of these
   * names, a folder among them saved whole. Without it, every file in `folder`.
   */
  named?: { depth: number; names: readonly string[] };
}

export const HARNESS_CONVERSATION_STATE: Record<
  Harness,
  HarnessConversationState | null
> = {
  // The Agent SDK's transcript, `<claudeSessionId>.jsonl`, and the folder of
  // the same name beside it (subagent transcripts). They sit in a folder named
  // after the working folder, in the CLI's own encoding, so it is found rather
  // than computed, and a restore runs in the same working folder.
  "claude-code": {
    idKey: "claudeSessionId",
    folder: ".claude/projects",
    named: { depth: 2, names: ["{id}.jsonl", "{id}"] },
  },
  // The rollouts `thread/resume` reads, in the session's own `CODEX_HOME`
  // (`codex-appserver/bridge/codex-home.ts`). Its `config.toml` carries the
  // relay credential and sits outside this folder.
  codex: {
    folder: "{sessionData}/codex-home/sessions",
  },
  // The folder `resumeSession` loads a thread from, in the CLI's own home in
  // the session's data folder, which the bridge makes its `COPILOT_HOME`
  // (`copilot-cli/bridge/index.ts`). Its `config.json` and logs, and the
  // bridge's start config holding the MCP proxy token, sit outside it.
  "copilot-cli": {
    idKey: "threadId",
    folder: "{sessionData}/copilot-home/session-state/{id}",
  },
  cursor: null,
  opencode: null,
  // The conversation lives on the vendor's servers, in the web account.
  "claude-web": null,
  "chatgpt-web": null,
};
