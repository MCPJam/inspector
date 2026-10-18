/**
 * Claude Code, Codex and Cursor each send their own hook payload and read
 * their own reply. `normalize` turns a payload into one event and `render`
 * turns a result back into what that host reads, so the handlers in
 * hook.mjs never branch on the host.
 *
 * An event is { host, name, kind, sessionId, cwd, prompt, files, continued,
 * transcriptPath }, where kind is start, prompt, edit, tool, stop or end.
 * A result is { context?, followup? }: text to add to the agent's context,
 * or the one message that keeps it working after it tried to stop.
 */
import { isAbsolute, join } from 'node:path';

export const HOSTS = ['claude', 'codex', 'cursor'];

const CLAUDE_KINDS = {
  SessionStart: 'start',
  UserPromptSubmit: 'prompt',
  PostToolUse: 'edit',
  Stop: 'stop',
  SessionEnd: 'end',
};

const CURSOR_KINDS = {
  sessionStart: 'start',
  beforeSubmitPrompt: 'prompt',
  afterFileEdit: 'edit',
  postToolUse: 'tool',
  stop: 'stop',
  sessionEnd: 'end',
};

/**
 * Where each host reads added context. Cursor ignores context from
 * beforeSubmitPrompt and afterFileEdit, so the handlers hold it for the next
 * event that can carry it.
 */
export const INJECTS = {
  claude: new Set(['start', 'prompt', 'edit']),
  codex: new Set(['start', 'prompt', 'edit']),
  cursor: new Set(['start', 'tool']),
};

/** Paths an `apply_patch` patch adds, updates, deletes or moves to. */
export function patchFiles(patch) {
  const files = [];
  for (const match of String(patch).matchAll(
    /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm
  )) {
    files.push(match[1].trim());
  }
  return files;
}

function absolute(cwd, files) {
  return files
    .filter(Boolean)
    .map((file) => (isAbsolute(file) ? file : join(cwd, file)));
}

function claudeLike(host, input) {
  const kind = CLAUDE_KINDS[input.hook_event_name] ?? null;
  const tool = input.tool_input ?? {};
  const files =
    kind !== 'edit'
      ? []
      : input.tool_name === 'apply_patch'
        ? patchFiles(tool.command ?? tool.input ?? '')
        : [tool.file_path ?? tool.notebook_path];
  const cwd = input.cwd ?? process.cwd();
  return {
    host,
    name: input.hook_event_name,
    kind,
    sessionId: String(input.session_id ?? ''),
    cwd,
    prompt: input.prompt ?? '',
    files: absolute(cwd, files),
    continued: Boolean(input.stop_hook_active),
    transcriptPath: input.transcript_path ?? null,
  };
}

function cursor(input, env) {
  const kind = CURSOR_KINDS[input.hook_event_name] ?? null;
  const tool = input.tool_input ?? {};
  const cwd =
    input.cwd ??
    input.workspace_roots?.[0] ??
    env.CURSOR_PROJECT_DIR ??
    process.cwd();
  let files = [];
  if (kind === 'edit') files = [input.file_path];
  if (kind === 'tool' && input.tool_name === 'Write') {
    files = [tool.file_path ?? tool.path];
  }
  return {
    host: 'cursor',
    name: input.hook_event_name,
    kind,
    sessionId: String(input.conversation_id ?? input.session_id ?? ''),
    cwd,
    prompt: input.prompt ?? '',
    files: absolute(cwd, files),
    continued: Number(input.loop_count ?? 0) > 0,
    transcriptPath: input.transcript_path ?? env.CURSOR_TRANSCRIPT_PATH ?? null,
  };
}

export function normalize(host, input, env = process.env) {
  if (host === 'cursor') return cursor(input, env);
  if (host === 'claude' || host === 'codex') return claudeLike(host, input);
  throw new Error(`Unknown host "${host}". Use ${HOSTS.join(', ')}.`);
}

/** What the host reads on stdout. Every host gets exit 0: these hooks never block. */
export function render(event, result = {}) {
  const { host, name, kind } = event;
  if (host === 'cursor') {
    if (kind === 'prompt') return JSON.stringify({ continue: true });
    if (kind === 'stop' && result.followup) {
      return JSON.stringify({ followup_message: result.followup });
    }
    if (result.context && INJECTS.cursor.has(kind)) {
      return JSON.stringify({ additional_context: result.context });
    }
    return '{}';
  }
  if (kind === 'stop' && result.followup) {
    return JSON.stringify({ decision: 'block', reason: result.followup });
  }
  if (result.context && INJECTS[host].has(kind)) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: name,
        additionalContext: result.context,
      },
    });
  }
  return '';
}
