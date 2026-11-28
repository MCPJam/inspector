import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";
import { HARNESS_CONVERSATION_STATE } from "../conversation-state";
import { getHarnessAdapter, harnessConversationState } from "../registry";
import {
  isPathUnderRoot,
  sessionFileSpec,
} from "../session-snapshot/session-files";

const HOME = "/home/user";
const declared = HARNESS_IDS.filter(
  (id) => HARNESS_CONVERSATION_STATE[id] !== null,
);

/** A committed session the way each runtime's resume state names it. */
function specFor(id: (typeof HARNESS_IDS)[number]) {
  const state = HARNESS_CONVERSATION_STATE[id];
  return sessionFileSpec({
    harnessId: id,
    conversationState: state,
    harnessSessionId: "hs-1",
    resumeState: {
      type: "resume-session",
      harnessId: id,
      data: state?.idKey ? { [state.idKey]: "cli-session-1" } : {},
    },
    home: HOME,
  });
}

describe("conversation-state declarations", () => {
  it("are what each registry entry declares, and nothing for an unknown id", () => {
    for (const id of HARNESS_IDS) {
      expect(getHarnessAdapter(id).conversationState, id).toBe(
        HARNESS_CONVERSATION_STATE[id],
      );
      expect(harnessConversationState(id), id).toBe(
        HARNESS_CONVERSATION_STATE[id],
      );
    }
    expect(harnessConversationState("toString")).toBeNull();
  });

  it("cover exactly the runtimes a replaced box was shown to resume from these files", () => {
    // Probe D: a first turn, these files alone on a fresh home, then a resume
    // that recalls it. A runtime joins this list with that evidence.
    expect(declared).toEqual(["claude-code", "codex", "copilot-cli"]);
  });

  it("each place a session on a hosted box", () => {
    for (const id of declared) expect(specFor(id), id).toBeDefined();
  });

  it("never reach the CLI's config or credentials, MCPJam's bridge state or the working folder", () => {
    const outside = [
      ".ai-sdk-harness/.agent-runs/hs-1/codex-home/config.toml",
      ".ai-sdk-harness/.agent-runs/hs-1/codex-home/auth.json",
      ".ai-sdk-harness/.agent-runs/hs-1/codex-home/state_5.sqlite",
      ".ai-sdk-harness/.agent-runs/hs-1/copilot-home/config.json",
      ".ai-sdk-harness/.agent-runs/hs-1/copilot-home/logs/process-1.log",
      ".ai-sdk-harness/.agent-runs/hs-1/copilot-home/session-state/other-thread/events.jsonl",
      ".ai-sdk-harness/.agent-runs/hs-1/bridge/start-config.json",
      ".ai-sdk-harness/.agent-runs/hs-2/codex-home/sessions/2026/11/16/rollout-x.jsonl",
      ".ai-sdk-harness/.harness-bootstrap/codex-appserver/bridge.mjs",
      ".claude.json",
      ".claude/settings.json",
      ".claude/.credentials.json",
      ".codex/auth.json",
      ".local/share/opencode/auth.json",
      ".ssh/id_rsa",
      ".bashrc",
      "claude-code-hs-1/notes.txt",
      "codex-hs-1/notes.txt",
    ];
    for (const id of declared) {
      const { root } = specFor(id)!;
      for (const path of outside) {
        expect(isPathUnderRoot(path, HOME, root), `${id}: ${path}`).toBe(false);
      }
    }
  });
});
