import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "./eng.mjs";
import { editedSourcePaths, isBuildPrompt, normalize, output } from "./hook.mjs";
import { describeTool, redact, renderRecord, unloggedDirectionChange } from "./record.mjs";
import { findOtherRepo, isMainCheckout, repoForRemote } from "./repos.mjs";
import { lastTurn, parseTranscript } from "./transcript.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "hook.mjs");

function sh(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "eng-hook-")));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@example.com");
  sh(dir, "config", "user.name", "T");
  sh(dir, "commit", "-q", "--allow-empty", "-m", "root");
  sh(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  sh(dir, "checkout", "-q", "-b", "feature");
  return dir;
}

/** Runs the hook as the agent would, with a clean HOME so no real config leaks in. */
function hook(agent, input, home = mkdtempSync(join(tmpdir(), "eng-home-"))) {
  const result = spawnSync("node", [HOOK, agent], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

const claudeLine = (role, content, extra = {}) =>
  JSON.stringify({ type: role, timestamp: "2026-10-17T10:00:00Z", message: { role, content }, ...extra });

describe("agent adapters", () => {
  it("reads each agent's payload into one shape", () => {
    const cursor = normalize("cursor", { hook_event_name: "stop", conversation_id: "c1", workspace_roots: ["/w"], loop_count: 1 });
    assert.deepEqual([cursor.event, cursor.sessionId, cursor.cwd, cursor.repeatStop], ["stop", "c1", "/w", true]);
    const codex = normalize("codex", { hook_event_name: "PostToolUse", session_id: "s", cwd: "/r", tool_name: "apply_patch", tool_input: { command: "x" } });
    assert.equal(codex.event, "edit");
  });

  it("writes context and stop follow-ups in each agent's format", () => {
    assert.deepEqual(output("cursor", "sessionStart", { context: "hi" }), { additional_context: "hi" });
    assert.deepEqual(output("codex", "SessionStart", { context: "hi" }), {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "hi" },
    });
    assert.deepEqual(output("claude", "Stop", { followUp: "log it" }), { decision: "block", reason: "log it" });
    assert.deepEqual(output("cursor", "stop", { followUp: "log it" }), { followup_message: "log it" });
    assert.equal(output("claude", "Stop", {}), null);
  });

  it("tells build work from questions", () => {
    assert.equal(isBuildPrompt("implement the eng tooling spec"), true);
    assert.equal(isBuildPrompt("how does the build step work here?"), false);
    assert.equal(isBuildPrompt("/eng plan"), false);
  });

  it("finds source paths in a Codex patch and skips agent config", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: .claude/x.json\n*** Add File: README.md\n*** End Patch";
    assert.deepEqual(editedSourcePaths("apply_patch", { command: patch }), ["src/a.ts"]);
    assert.deepEqual(editedSourcePaths("Edit", { file_path: "/r/lib/b.mjs" }), ["/r/lib/b.mjs"]);
  });
});

describe("transcripts and records", () => {
  const claude = [
    claudeLine("user", "add a retry to the fetcher"),
    claudeLine("assistant", [{ type: "tool_use", id: "1", name: "Read", input: { file_path: "a.ts" } }]),
    claudeLine("assistant", [{ type: "tool_use", id: "2", name: "Edit", input: { file_path: "a.ts" } }]),
    claudeLine("assistant", [{ type: "tool_use", id: "3", name: "Bash", input: { command: "npx vitest run a" } }]),
    claudeLine("user", [{ type: "tool_result", tool_use_id: "3", content: "Tests 4 passed" }]),
    claudeLine("assistant", [{ type: "text", text: "Done. Key was OPENAI_API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaa" }]),
    claudeLine("user", "<system-reminder>ignore</system-reminder>"),
  ].join("\n");

  it("parses Claude Code lines and drops injected messages", () => {
    const events = parseTranscript(claude);
    assert.deepEqual(events.map((e) => e.kind), ["prompt", "tool", "tool", "tool", "answer"]);
    assert.equal(events[3].output, "Tests 4 passed");
  });

  it("parses Codex rollout lines", () => {
    const codex = [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] } },
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"command":["git","status"]}', call_id: "c" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c", output: "clean" } },
    ].map((l) => JSON.stringify(l)).join("\n");
    const events = parseTranscript(codex);
    assert.equal(events[1].output, "clean");
    assert.equal(describeTool(events[1]), "Ran: `git status`");
  });

  it("renders a redacted record with reads collapsed", () => {
    const text = renderRecord(parseTranscript(claude), { task: "PP-1", branch: "feature", sessionId: "s", agent: "claude" });
    assert.match(text, /Looked at 1 thing\(s\): Read/);
    assert.match(text, /Edited `a.ts`/);
    assert.match(text, /Tests: `npx vitest run a`/);
    assert.doesNotMatch(text, /sk-proj/);
    assert.match(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), /Bearer \[redacted\]/);
  });

  it("flags a direction change only when nothing was logged", () => {
    const changed = [{ kind: "prompt", text: "go" }, { kind: "answer", text: "The cache idea failed, so I'm taking a different approach." }];
    assert.equal(unloggedDirectionChange(lastTurn(changed)), true);
    const logged = [...changed, { kind: "tool", name: "mcp__kestral__execute_operation", input: { operationId: "create_comment" } }];
    assert.equal(unloggedDirectionChange(lastTurn(logged)), false);
  });
});

describe("hooks end to end", () => {
  it("offers once per branch, and declining is remembered", () => {
    const dir = repo();
    const prompt = { hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "s", prompt: "implement the retry queue" };
    assert.match(hook("claude", prompt).hookSpecificOutput.additionalContext, /has no Kestral task/);
    assert.equal(hook("claude", prompt), null);
    const other = repo();
    run(["decline"], other);
    assert.equal(hook("claude", { ...prompt, cwd: other }), null);
    const edit = { hook_event_name: "PostToolUse", cwd: other, tool_name: "Edit", tool_input: { file_path: join(other, "a.ts") } };
    assert.equal(hook("claude", edit), null);
  });

  it("resumes a mapped branch, shares it with the stack and saves a session record", () => {
    const dir = repo();
    run(["map", "PP-7", "https://app.kestral.ai/t/1"], dir);
    run(["step", "build"], dir);
    sh(dir, "commit", "-q", "--allow-empty", "-m", "part one");
    sh(dir, "checkout", "-q", "-b", "feature-2");
    const home = mkdtempSync(join(tmpdir(), "eng-home-"));
    const start = hook("codex", { hook_event_name: "SessionStart", cwd: dir, session_id: "s1" }, home);
    const context = start.hookSpecificOutput.additionalContext;
    assert.match(context, /Kestral task PP-7/);
    assert.match(context, /inherited from `feature`/);
    assert.match(context, /Eng flow step: build/);
    assert.match(context, /Kestral connector is not installed/);

    const transcript = join(dir, "..", `${Date.now()}.jsonl`);
    writeFileSync(transcript, [
      claudeLine("user", "keep going"),
      claudeLine("assistant", [{ type: "tool_use", id: "e", name: "Write", input: { file_path: "q.ts" } }]),
      claudeLine("assistant", [{ type: "text", text: "Locks deadlocked, so I'm switching approach to a queue." }]),
    ].join("\n"));
    const stop = { hook_event_name: "Stop", cwd: dir, session_id: "s1", transcript_path: transcript };
    assert.match(hook("claude", stop).reason, /logged no decision/);
    assert.equal(hook("claude", { ...stop, stop_hook_active: true }), null);
    const status = JSON.parse(run(["status"], dir));
    assert.ok(existsSync(status.records.s1.path));
    assert.match(readFileSync(status.records.s1.path, "utf8"), /Edited `q.ts`/);
  });

  it("adds the task trailer to commit messages", () => {
    const dir = repo();
    run(["map", "PP-9"], dir);
    const msg = join(dir, ".git", "MSG");
    writeFileSync(msg, "Fix the thing\n");
    run(["trailer", msg], dir);
    run(["trailer", msg], dir);
    assert.equal(readFileSync(msg, "utf8").match(/Kestral: PP-9/g).length, 1);
  });
});

describe("other repo lookup", () => {
  it("recognises MCPJam remotes in both URL styles", () => {
    assert.equal(repoForRemote("git@github.com:MCPJam/inspector.git"), "inspector");
    assert.equal(repoForRemote("https://github.com/MCPJam/mcpjam-backend"), "backend");
    assert.equal(repoForRemote("https://github.com/someone/inspector.git"), null);
  });

  it("uses the override and accepts only a main checkout with the right origin", () => {
    const here = repo();
    sh(here, "remote", "add", "origin", "git@github.com:MCPJam/inspector.git");
    const backend = repo();
    sh(backend, "remote", "add", "origin", "git@github.com:MCPJam/mcpjam-backend.git");
    assert.equal(isMainCheckout(backend, "backend"), true);
    assert.equal(isMainCheckout(backend, "inspector"), false);
    const home = mkdtempSync(join(tmpdir(), "eng-home-"));
    const found = findOtherRepo(here, { home, env: { MCPJAM_BACKEND_DIR: backend } });
    assert.deepEqual(found, { key: "backend", dir: backend, how: "MCPJAM_BACKEND_DIR" });
  });
});
