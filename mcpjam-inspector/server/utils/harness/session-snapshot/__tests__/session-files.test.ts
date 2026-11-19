import { describe, expect, it } from "vitest";
import {
  HARNESS_CONVERSATION_STATE,
  type HarnessConversationState,
} from "../../conversation-state";
import {
  isPathUnderRoot,
  parseFileListing,
  sessionFileSpec,
} from "../session-files";

const HOME = "/home/user";
const CLAUDE_STATE = {
  type: "resume-session",
  harnessId: "claude-code",
  data: { claudeSessionId: "0f8e1c1e-6a4b-4f58-9b7e-2f6f5b9d1a10" },
};
const spec = (
  harnessId: keyof typeof HARNESS_CONVERSATION_STATE,
  overrides: Partial<Parameters<typeof sessionFileSpec>[0]> = {},
) =>
  sessionFileSpec({
    harnessId,
    conversationState: HARNESS_CONVERSATION_STATE[harnessId],
    harnessSessionId: "hs-1",
    resumeState: {},
    home: HOME,
    ...overrides,
  });

describe("sessionFileSpec", () => {
  it("finds a Claude Code transcript and its subagent folder by session id, two folders down", () => {
    const claude = spec("claude-code", { resumeState: CLAUDE_STATE });
    expect(claude).toEqual({
      harnessId: "claude-code",
      root: "/home/user/.claude/projects",
      listCommand:
        "find '/home/user/.claude/projects' -mindepth 2 -maxdepth 2 " +
        "\\( -name '0f8e1c1e-6a4b-4f58-9b7e-2f6f5b9d1a10.jsonl' " +
        "-o -name '0f8e1c1e-6a4b-4f58-9b7e-2f6f5b9d1a10' \\) " +
        "-exec find {} -type f -printf '%s\\t%p\\n' \\; 2>/dev/null",
    });
  });

  it("saves only Codex's rollouts, never the rest of its home", () => {
    expect(spec("codex")).toEqual({
      harnessId: "codex",
      root: "/home/user/.ai-sdk-harness/.agent-runs/hs-1/codex-home/sessions",
      listCommand:
        "find '/home/user/.ai-sdk-harness/.agent-runs/hs-1/codex-home/sessions' " +
        "-type f -printf '%s\\t%p\\n' 2>/dev/null",
    });
  });

  it("saves only the Copilot CLI thread's own session folder", () => {
    expect(
      spec("copilot-cli", {
        resumeState: { data: { threadId: "4aa3e560-b067" } },
      }),
    ).toEqual({
      harnessId: "copilot-cli",
      root: "/home/user/.ai-sdk-harness/.agent-runs/hs-1/copilot-home/session-state/4aa3e560-b067",
      listCommand:
        "find '/home/user/.ai-sdk-harness/.agent-runs/hs-1/copilot-home/session-state/4aa3e560-b067' " +
        "-type f -printf '%s\\t%p\\n' 2>/dev/null",
    });
    expect(spec("copilot-cli")).toBeUndefined();
    expect(
      spec("copilot-cli", { resumeState: { data: { threadId: "../x" } } }),
    ).toBeUndefined();
  });

  it("refuses runtimes that declare nothing and ids it cannot quote safely", () => {
    expect(spec("cursor")).toBeUndefined();
    expect(spec("claude-code")).toBeUndefined();
    expect(
      spec("claude-code", {
        resumeState: { data: { claudeSessionId: "x'; rm -rf ~; '" } },
      }),
    ).toBeUndefined();
    expect(
      spec("claude-code", {
        resumeState: { data: { claudeSessionId: "a.b" } },
      }),
    ).toBeUndefined();
    expect(spec("codex", { harnessSessionId: "../x" })).toBeUndefined();
    expect(spec("codex", { home: "/home/it's" })).toBeUndefined();
  });

  it("refuses a declaration that would reach outside its own folder", () => {
    const declared = (state: HarnessConversationState) =>
      sessionFileSpec({
        harnessId: "probe",
        conversationState: state,
        harnessSessionId: "hs-1",
        resumeState: { data: { id: "abc" } },
        home: HOME,
      });
    expect(declared({ folder: "../etc" })).toBeUndefined();
    expect(declared({ folder: "" })).toBeUndefined();
    expect(declared({ folder: ".x/{id}" })).toBeUndefined();
    expect(
      declared({
        idKey: "id",
        folder: ".x",
        named: { depth: 1, names: ["a/b"] },
      }),
    ).toBeUndefined();
    expect(
      declared({
        idKey: "id",
        folder: ".x",
        named: { depth: 0, names: ["{id}"] },
      }),
    ).toBeUndefined();
    expect(
      declared({
        idKey: "id",
        folder: ".x",
        named: { depth: 1, names: [".."] },
      }),
    ).toBeUndefined();
    expect(declared({ idKey: "id", folder: ".x/{id}" })?.root).toBe(
      "/home/user/.x/abc",
    );
  });
});

describe("isPathUnderRoot", () => {
  const root = "/home/user/.claude/projects";
  it("accepts the CLI's own names under the root", () => {
    expect(
      isPathUnderRoot(".claude/projects/-home-user-w/abc.jsonl", HOME, root),
    ).toBe(true);
    expect(
      isPathUnderRoot(
        ".claude/projects/-home-user-w/abc/subagents/a.jsonl",
        HOME,
        root,
      ),
    ).toBe(true);
  });
  it("refuses anything that could land elsewhere or need quoting", () => {
    for (const path of [
      "/etc/passwd",
      ".claude/projects/../../.ssh/id_rsa",
      ".claude/settings.json",
      ".claude/projects/x/it's.jsonl",
      ".claude/projects//x.jsonl",
      "",
    ]) {
      expect(isPathUnderRoot(path, HOME, root), path).toBe(false);
    }
  });
});

describe("parseFileListing", () => {
  it("keeps sized files under the root, relative to home", () => {
    const root = "/home/user/.claude/projects";
    const stdout = [
      "120\t/home/user/.claude/projects/-home-user-w/abc.jsonl",
      "9\t/home/user/.claude/settings.json",
      "garbage",
      "",
    ].join("\n");
    expect(parseFileListing(stdout, HOME, root)).toEqual([
      { path: ".claude/projects/-home-user-w/abc.jsonl", bytes: 120 },
    ]);
  });
});
