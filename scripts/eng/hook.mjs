#!/usr/bin/env node
/**
 * Eng flow hooks for Claude Code, Codex and Cursor. Each agent's config calls
 * `node scripts/eng/hook.mjs <claude|codex|cursor>` with the event on stdin.
 *
 *   session start   resume a mapped branch, locate the other repo, check for
 *                   the Kestral connector, list session records to upload;
 *                   on Cursor also the prompt nudge, which it cannot inject later
 *   prompt submit   offer the flow on a build-shaped prompt, once per branch
 *   post tool use   offer the flow on the first source edit, once per branch
 *   stop            save the session record; remind once about a direction
 *                   change with no decision logged
 *
 * Nothing here blocks work. A failure of the hook itself exits 0 silently.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { didWork, patchPaths, renderRecord, unloggedDirectionChange } from "./record.mjs";
import { describeOtherRepo, findOtherRepo } from "./repos.mjs";
import { checkoutOf, debug, entryFor, isTaskBranch, readState, sessionRecordPath, updateState } from "./state.mjs";
import { lastTurn, readTranscript } from "./transcript.mjs";

const SKILL = ".agents/skills/eng/SKILL.md";
const CLI = "node scripts/eng/eng.mjs";

const EVENTS = {
  sessionstart: "start",
  userpromptsubmit: "prompt",
  beforesubmitprompt: "prompt",
  posttooluse: "edit",
  afterfileedit: "edit",
  stop: "stop",
};

/** One shape for every agent's payload. */
export function normalize(agent, input) {
  return {
    agent,
    event: EVENTS[String(input.hook_event_name ?? "").toLowerCase()] ?? null,
    eventName: input.hook_event_name,
    cwd: input.cwd ?? input.workspace_roots?.[0] ?? process.env.CURSOR_PROJECT_DIR ?? process.cwd(),
    sessionId: String(input.session_id ?? input.conversation_id ?? "unknown"),
    transcript: input.transcript_path ?? null,
    prompt: input.prompt ?? "",
    toolName: input.tool_name ?? "",
    toolInput: input.tool_input ?? (input.file_path ? { file_path: input.file_path } : {}),
    // Claude and Codex set stop_hook_active; Cursor counts its follow-ups.
    repeatStop: Boolean(input.stop_hook_active) || Number(input.loop_count ?? 0) > 0,
  };
}

/** The JSON each agent expects for added context, or a Stop continuation. */
export function output(agent, eventName, { context, followUp }) {
  if (followUp) {
    return agent === "cursor" ? { followup_message: followUp } : { decision: "block", reason: followUp };
  }
  if (!context) return null;
  if (agent === "cursor") return { additional_context: context };
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: context } };
}

const BUILD_VERB =
  /\b(?:implement|build|add|create|write|refactor|migrate|port|wire|ship|support|introduce|replace|rework|redesign|rewrite|fix|change|update|remove|delete)\b/i;
const QUESTION = /^\s*(?:what|why|how|where|when|who|which|is|are|does|do|can you explain|explain|tell me|show me|summari[sz]e|review|look at)\b/i;

export function isBuildPrompt(prompt) {
  const text = String(prompt).trim();
  if (text.length < 15 || text.startsWith("/")) return false;
  return BUILD_VERB.test(text) && !QUESTION.test(text);
}

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|css|scss|html|sql|sh|ya?ml|toml)$/i;

export function editedSourcePaths(toolName, toolInput) {
  const direct = toolInput.file_path ?? toolInput.path;
  const paths = direct ? [direct] : /apply_patch/i.test(toolName) ? patchPaths(toolInput.command ?? toolInput.input ?? "") : [];
  return paths.filter((p) => SOURCE.test(p) && !/(?:^|\/)\.(?:agents|claude|codex|cursor)\//.test(p));
}

const offerText = (branch) =>
  [
    `Branch \`${branch}\` has no Kestral task. Before going further, offer the eng flow in one sentence:`,
    "a task, a product and eng spec, a reviewed plan, a decision log and a review page, with two approvals and no commands.",
    "The engineer decides: a clean bug fix usually skips it, a multi-PR stack uses it.",
    `On yes, read ${SKILL} and start at step 01. On no, run \`${CLI} decline\` and do not offer again on this branch.`,
  ].join(" ");

/** Marks the branch offered and returns the offer, or null if it was made. */
function offerOnce(checkout, state) {
  if (!isTaskBranch(checkout.branch) || entryFor(state, checkout)) return null;
  updateState(checkout.engDir, (s) => {
    s.branches[checkout.branch] = { offered: new Date().toISOString() };
  });
  return offerText(checkout.branch);
}

function kestralInstalled(agent, home = homedir()) {
  const files = {
    claude: [".claude.json", ".claude/plugins/installed_plugins.json", ".claude/settings.json"],
    codex: [".codex/config.toml"],
    cursor: [".cursor/mcp.json"],
  }[agent];
  if (existsSync(join(home, ".kestral/bin/kestral-mcp"))) return true;
  return files.some((file) => {
    const path = join(home, file);
    return existsSync(path) && /kestral/i.test(readFileSync(path, "utf8"));
  });
}

const KESTRAL_SETUP = {
  claude: "curl -fsSL https://raw.githubusercontent.com/Kestral-Team/kestral-plugins/main/setup.sh | bash -s -- --app claude-code",
  codex: "curl -fsSL https://raw.githubusercontent.com/Kestral-Team/kestral-plugins/main/setup.sh | bash -s -- --app codex",
  cursor: 'add {"mcpServers":{"kestral":{"url":"https://app.kestral.ai/mcp"}}} to ~/.cursor/mcp.json',
};

function pendingRecords(state, task, currentSession) {
  return Object.entries(state.sessions)
    .filter(([id, s]) => s.task === task && id !== currentSession && (!s.uploadedAt || s.uploadedAt < s.updatedAt))
    .map(([id, s]) => `- \`${s.path}\` (session ${id}, run \`${CLI} uploaded ${id}\` after upload)`);
}

function onStart(hook, checkout) {
  const state = readState(checkout.engDir);
  const entry = entryFor(state, checkout);
  const parts = [];
  if (entry?.task) {
    const from = entry.inherited ? ` (inherited from \`${entry.branch}\`, lower in the same stack; run \`${CLI} map ${entry.task}\` to confirm)` : "";
    parts.push(
      `This branch belongs to Kestral task ${entry.task}${entry.url ? ` (${entry.url})` : ""}${from}.`,
      `Eng flow step: ${entry.step ?? "task"}. Read ${SKILL} and continue from that step; do not restart the flow.`,
    );
    const pending = pendingRecords(state, entry.task, hook.sessionId);
    if (pending.length) {
      parts.push(`Session records not yet on the task. Upload each as its own Kestral document attached to ${entry.task}:`, ...pending);
    }
  } else if (hook.agent === "cursor") {
    // Cursor cannot add context on prompt submit, so the offer goes here.
    const offer = offerOnce(checkout, state);
    if (offer) parts.push(`If the engineer's request is build work: ${offer}`);
  }
  const other = describeOtherRepo(findOtherRepo(checkout.root));
  if (other) parts.push(other);
  if (!kestralInstalled(hook.agent)) {
    parts.push(`The Kestral connector is not installed for this agent, so task uploads will be skipped. Tell the engineer once: ${KESTRAL_SETUP[hook.agent]}`);
  }
  return { context: parts.join("\n") };
}

function onStop(hook, checkout) {
  const state = readState(checkout.engDir);
  const entry = entryFor(state, checkout);
  if (!entry?.task) return {};
  const events = readTranscript(hook.transcript);
  if (didWork(events)) {
    const path = sessionRecordPath(checkout.engDir, hook.sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderRecord(events, { task: entry.task, branch: checkout.branch, sessionId: hook.sessionId, agent: hook.agent }));
    updateState(checkout.engDir, (s) => {
      s.sessions[hook.sessionId] = { ...s.sessions[hook.sessionId], task: entry.task, path, updatedAt: new Date().toISOString() };
    });
  }
  if (hook.repeatStop || !["build", "plan", "review2"].includes(entry.step)) return {};
  if (!unloggedDirectionChange(lastTurn(events))) return {};
  return {
    followUp: `This turn changed direction but logged no decision. Add one comment to ${entry.task} (what, why, alternatives, who), citing any entry it overturns, using templates/decision.md from ${SKILL}. If nothing actually changed, say so in one line.`,
  };
}

export function handle(hook) {
  if (!hook.event) return null;
  const checkout = checkoutOf(hook.cwd);
  if (!checkout) return null;
  if (hook.event === "start") return onStart(hook, checkout);
  if (hook.event === "stop") return onStop(hook, checkout);
  const state = readState(checkout.engDir);
  if (hook.event === "prompt" && isBuildPrompt(hook.prompt)) return { context: offerOnce(checkout, state) };
  if (hook.event === "edit" && editedSourcePaths(hook.toolName, hook.toolInput).length) {
    return { context: offerOnce(checkout, state) };
  }
  return null;
}

function main() {
  const agent = ["claude", "codex", "cursor"].includes(process.argv[2]) ? process.argv[2] : "claude";
  const hook = normalize(agent, JSON.parse(readFileSync(0, "utf8")));
  const result = handle(hook);
  const json = result && output(agent, hook.eventName, result);
  if (json) process.stdout.write(`${JSON.stringify(json)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    // A broken hook must never wedge a session.
    debug(`hook failed: ${error.stack ?? error.message}`);
  }
  process.exitCode = 0;
}
