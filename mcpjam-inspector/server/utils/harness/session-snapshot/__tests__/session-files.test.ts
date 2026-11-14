import { describe, expect, it } from "vitest";
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

describe("sessionFileSpec", () => {
  it("finds a Claude Code transcript by its session id under ~/.claude/projects", () => {
    const spec = sessionFileSpec({
      harnessId: "claude-code",
      harnessSessionId: "hs-1",
      resumeState: CLAUDE_STATE,
      home: HOME,
    });
    expect(spec?.root).toBe("/home/user/.claude/projects");
    expect(spec?.listCommand).toContain(
      "-name '0f8e1c1e-6a4b-4f58-9b7e-2f6f5b9d1a10.jsonl'",
    );
  });

  it("saves only Codex's rollouts, never the rest of its home", () => {
    const spec = sessionFileSpec({
      harnessId: "codex",
      harnessSessionId: "hs-1",
      resumeState: {},
      home: HOME,
    });
    expect(spec?.root).toBe(
      "/home/user/.ai-sdk-harness/.agent-runs/hs-1/codex-home/sessions",
    );
  });

  it("refuses runtimes it cannot restore and ids it cannot quote safely", () => {
    const base = { harnessSessionId: "hs-1", home: HOME };
    expect(
      sessionFileSpec({ ...base, harnessId: "cursor", resumeState: {} }),
    ).toBeUndefined();
    expect(
      sessionFileSpec({ ...base, harnessId: "claude-code", resumeState: {} }),
    ).toBeUndefined();
    expect(
      sessionFileSpec({
        ...base,
        harnessId: "claude-code",
        resumeState: { data: { claudeSessionId: "x'; rm -rf ~; '" } },
      }),
    ).toBeUndefined();
    expect(
      sessionFileSpec({
        ...base,
        harnessId: "codex",
        harnessSessionId: "../x",
        resumeState: {},
      }),
    ).toBeUndefined();
    expect(
      sessionFileSpec({
        ...base,
        harnessId: "codex",
        home: "/home/it's",
        resumeState: {},
      }),
    ).toBeUndefined();
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
