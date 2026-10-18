/**
 * Turns transcript events into the session record: every prompt, answer,
 * command, file change, commit and test result in order, with timestamps.
 * Nothing is dropped. Read-only tool calls collapse into one line per run,
 * long outputs keep their last lines, and secrets are replaced before the
 * text leaves the machine.
 */

/** [pattern, replacement]: labels and URL schemes stay, values go. */
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]"],
  [/\b(?:sk|pk|rk)-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, "[redacted]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, "$1 [redacted]"],
  [
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)(\s*[=:]\s*)["']?[^\s"']{6,}["']?/gi,
    "$1$2[redacted]",
  ],
  [/\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1[redacted]@"],
];

export function redact(text) {
  let out = String(text ?? "");
  for (const [pattern, replacement] of SECRETS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

const READ_ONLY =
  /^(?:Read|Grep|Glob|LS|NotebookRead|WebFetch|WebSearch|ToolSearch|TodoWrite|TaskList|TaskGet|read_file|list_dir|grep|glob|codebase_search|file_search|view_image|update_plan|mcp__.*__(?:read|get|list|search|find|query)[\w-]*)$/i;
const EDIT = /^(?:Edit|MultiEdit|Write|NotebookEdit|apply_patch|edit_file|write|search_replace)$/i;
const TEST_COMMAND = /\b(?:vitest|jest|pytest|node --test|npm (?:run )?test|npm run verify|go test|cargo test)\b/;

export function patchPaths(patch) {
  return [...String(patch).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(
    (match) => match[1].trim(),
  );
}

function editedPaths(input) {
  const direct = input.file_path ?? input.path ?? input.notebook_path;
  if (direct) return [direct];
  return patchPaths(input.command ?? input.patch ?? input.input ?? "");
}

function tail(text, lines) {
  const all = String(text ?? "").trimEnd().split("\n");
  return all.length > lines ? all.slice(-lines).join("\n") : all.join("\n");
}

function commandOf(input) {
  const value = input.command ?? input.cmd;
  return Array.isArray(value) ? value.join(" ") : String(value ?? "");
}

/** One record line (or block) for a tool call, or null for read-only calls. */
export function describeTool(event) {
  const input = event.input ?? {};
  if (READ_ONLY.test(event.name)) return null;
  if (EDIT.test(event.name)) {
    return `Edited ${editedPaths(input).map((p) => `\`${p}\``).join(", ") || "a file"}`;
  }
  const command = commandOf(input);
  if (command) {
    const commit = command.match(/git commit[^\n]*?-m\s+["']([^"'\n]+)/);
    if (commit) return `Commit: ${commit[1]}`;
    const status = event.error ? " (failed)" : "";
    if (TEST_COMMAND.test(command)) {
      return `Tests${status}: \`${command.split("\n")[0]}\`\n\n\`\`\`\n${tail(event.output, 6)}\n\`\`\``;
    }
    const output = event.error ? `\n\n\`\`\`\n${tail(event.output, 4)}\n\`\`\`` : "";
    return `Ran${status}: \`${command.split("\n")[0].slice(0, 200)}\`${output}`;
  }
  if (isDecisionLog(event)) return "Logged a decision on the task";
  return `Called ${event.name}`;
}

/** A comment written to Kestral, which is how a decision gets logged. */
export function isDecisionLog(event) {
  if (event.kind !== "tool" || !/kestral/i.test(event.name)) return false;
  return /comment/i.test(JSON.stringify(event.input ?? {}));
}

const DIRECTION_CHANGE =
  /\b(?:change of plan|changing (?:the )?(?:plan|approach)|deviat(?:e|es|ed|ing|ion) from (?:the )?plan|instead of (?:what )?the plan|(?:the )?plan (?:no longer|doesn't|does not) (?:work|hold)|switch(?:ing|ed)? (?:approach|to a different approach)|(?:a )?different approach|new approach|revis(?:e|ed|ing) the plan|drop(?:ping|ped)? (?:the|that) (?:approach|idea))\b/i;

/** The turn changed direction and logged nothing about it. */
export function unloggedDirectionChange(turn) {
  const changed = turn.some((e) => e.kind === "answer" && DIRECTION_CHANGE.test(e.text));
  return changed && !turn.some(isDecisionLog);
}

/** Whether a session changed anything: a record is only kept for those. */
export function didWork(events) {
  return events.some(
    (e) => e.kind === "tool" && (EDIT.test(e.name) || /git commit/.test(commandOf(e.input ?? {}))),
  );
}

function time(ts) {
  return ts ? new Date(ts).toISOString().replace("T", " ").slice(0, 16) : "--";
}

function quote(text) {
  return redact(text).trim().split("\n").map((line) => `> ${line}`).join("\n");
}

export function renderRecord(events, { task, branch, sessionId, agent }) {
  const lines = [
    `# Session record: ${task ?? "no task"}`,
    "",
    `Agent: ${agent}. Branch: \`${branch}\`. Session: \`${sessionId}\`.`,
    "",
  ];
  let reads = [];
  const flushReads = () => {
    if (!reads.length) return;
    lines.push(`- ${time(reads[0].ts)} Looked at ${reads.length} thing(s): ${[...new Set(reads.map((e) => e.name))].join(", ")}`);
    reads = [];
  };
  for (const event of events) {
    if (event.kind === "tool") {
      const line = describeTool(event);
      if (line === null) reads.push(event);
      else {
        flushReads();
        lines.push(`- ${time(event.ts)} ${redact(line)}`);
      }
      continue;
    }
    flushReads();
    const who = event.kind === "prompt" ? "Engineer" : "Agent";
    lines.push("", `**${time(event.ts)} ${who}**`, "", quote(event.text), "");
  }
  flushReads();
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
