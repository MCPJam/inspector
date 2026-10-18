/**
 * Reads an agent's session transcript into one event list:
 *   { ts, kind: "prompt" | "answer" | "tool", name?, input?, output?, error? }
 *
 * Claude Code writes one message per JSONL line, with tool calls and their
 * results as content blocks. Codex writes rollout lines whose payload is a
 * message, a function call or its output. Neither format is documented as
 * stable, so anything else falls back to lines that carry a role and text.
 */
import { existsSync, readFileSync } from "node:fs";
import { debug } from "./state.mjs";

/** Text an agent injects as a user message that no person typed. */
const INJECTED =
  /^\s*<(?:environment_context|user_instructions|system-reminder|command-name|local-command|task-notification)|^\s*# AGENTS\.md/;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function parseArguments(value) {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    // apply_patch and shell calls can pass raw text rather than JSON.
    return { command: value };
  }
}

function fromClaude(line, events, byId) {
  if (line.isSidechain || line.isMeta) return;
  const ts = line.timestamp;
  const content = line.message?.content;
  const role = line.message?.role ?? line.type;
  if (role === "user" && typeof content === "string") {
    if (!INJECTED.test(content)) events.push({ ts, kind: "prompt", text: content });
    return;
  }
  for (const block of Array.isArray(content) ? content : []) {
    if (block.type === "text" && block.text?.trim()) {
      const kind = role === "assistant" ? "answer" : "prompt";
      if (kind === "answer" || !INJECTED.test(block.text)) {
        events.push({ ts, kind, text: block.text });
      }
    } else if (block.type === "tool_use") {
      const event = { ts, kind: "tool", name: block.name, input: block.input ?? {} };
      byId.set(block.id, event);
      events.push(event);
    } else if (block.type === "tool_result" && byId.has(block.tool_use_id)) {
      const event = byId.get(block.tool_use_id);
      event.output = textOf(block.content);
      event.error = Boolean(block.is_error);
    }
  }
}

function fromCodex(line, events, byId) {
  const ts = line.timestamp;
  const item = line.payload;
  if (item.type === "message") {
    const text = textOf(item.content);
    if (!text.trim()) return;
    if (item.role === "assistant") events.push({ ts, kind: "answer", text });
    else if (item.role === "user" && !INJECTED.test(text)) {
      events.push({ ts, kind: "prompt", text });
    }
  } else if (/_call$/.test(item.type) && item.name) {
    const input = parseArguments(item.arguments ?? item.input);
    const event = { ts, kind: "tool", name: item.name, input };
    byId.set(item.call_id, event);
    events.push(event);
  } else if (/_call_output$/.test(item.type) && byId.has(item.call_id)) {
    const output = item.output;
    byId.get(item.call_id).output =
      typeof output === "string" ? output : JSON.stringify(output);
  }
}

function fromGeneric(line, events) {
  const role = line.role ?? line.message?.role;
  const text = textOf(line.content ?? line.message?.content ?? line.text);
  if (!text.trim()) return;
  if (role === "assistant") events.push({ ts: line.timestamp, kind: "answer", text });
  else if (role === "user" && !INJECTED.test(text)) {
    events.push({ ts: line.timestamp, kind: "prompt", text });
  }
}

export function parseTranscript(text) {
  const events = [];
  const byId = new Map();
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      // A partly written last line is normal while the session runs.
      continue;
    }
    if (line.payload && line.type === "response_item") fromCodex(line, events, byId);
    else if (line.message || line.type === "user" || line.type === "assistant") {
      fromClaude(line, events, byId);
    } else fromGeneric(line, events);
  }
  return events;
}

export function readTranscript(path) {
  if (!path || !existsSync(path)) return [];
  try {
    return parseTranscript(readFileSync(path, "utf8"));
  } catch (error) {
    debug(`transcript unreadable: ${error.message}`);
    return [];
  }
}

/** Events since the last prompt: the turn that is ending. */
export function lastTurn(events) {
  let start = 0;
  events.forEach((event, index) => {
    if (event.kind === "prompt") start = index;
  });
  return events.slice(start);
}
