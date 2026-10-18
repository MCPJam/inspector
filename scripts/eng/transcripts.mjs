/**
 * Turns each host's transcript into one list of session events. None of
 * the formats is a stable interface (Codex says so outright), so every line
 * is either parsed, skipped as a known line with nothing to record, or
 * counted as unknown. The session record reports unknown lines as an
 * incomplete capture; nothing is guessed to fill the gap.
 *
 * An event is { at, kind, text, detail?, id?, ref? }: kind is prompt,
 * answer, command, edit, tool or output; `at` is the host's timestamp or
 * null when it gave none; `ref` ties an output to the call that produced it.
 */
import { patchFiles } from './hosts.mjs';

const clip = (value) => String(value ?? '').trim();

function toolEvent(at, name, input, id) {
  if (name === 'Bash' || name === 'Shell') {
    return { at, kind: 'command', text: clip(input?.command), id };
  }
  if (/^(?:Edit|MultiEdit|Write|NotebookEdit|StrReplace|Delete)$/.test(name)) {
    const file = input?.file_path ?? input?.notebook_path ?? input?.path;
    return { at, kind: 'edit', text: clip(file), id };
  }
  return {
    at,
    kind: 'tool',
    text: `${name} ${JSON.stringify(input ?? {})}`,
    id,
  };
}

const resultText = (content) =>
  Array.isArray(content)
    ? content.map((part) => part.text ?? '').join('\n')
    : clip(content);

const SILENT_BLOCKS = new Set(['thinking', 'redacted_thinking']);

/**
 * Claude Code and Cursor share content blocks: text, tool_use, tool_result.
 * A block of any other kind becomes an `unknown` event, which is counted.
 */
function blocks(at, role, content) {
  if (typeof content === 'string') {
    return [
      { at, kind: role === 'user' ? 'prompt' : 'answer', text: clip(content) },
    ];
  }
  const events = [];
  for (const block of content ?? []) {
    if (block.type === 'text' && clip(block.text)) {
      const text = clip(block.text)
        .replace(/<\/?user_query>/g, '')
        .trim();
      events.push({ at, kind: role === 'user' ? 'prompt' : 'answer', text });
    } else if (block.type === 'tool_use') {
      events.push(toolEvent(at, block.name, block.input, block.id));
    } else if (block.type === 'tool_result') {
      const detail = resultText(block.content);
      const text = `${block.is_error ? 'error: ' : ''}${detail.split('\n')[0]}`;
      events.push({ at, kind: 'output', text, detail, ref: block.tool_use_id });
    } else if (block.type === 'image') {
      events.push({ at, kind: 'prompt', text: '[image attached]' });
    } else if (!SILENT_BLOCKS.has(block.type) && block.type !== 'text') {
      events.push({ at, kind: 'unknown', text: block.type });
    }
  }
  return events;
}

/**
 * Claude Code writes the conversation as user and assistant lines and adds
 * metadata lines of changing types (summaries, snapshots, queue and hook
 * bookkeeping) that carry none of it, so only the conversation is read.
 */
function claude(line) {
  if (line.type !== 'user' && line.type !== 'assistant') return [];
  if (!line.message) return null;
  if (line.isMeta) return [];
  return blocks(
    line.timestamp ?? null,
    line.message.role,
    line.message.content
  );
}

const CODEX_SKIP = new Set(['session_meta', 'turn_context', 'compacted']);
const CODEX_ITEM_SKIP = new Set(['message', 'reasoning']);

/** A Codex shell call names its command as an argv array or one string. */
function codexCommand(args) {
  const parsed = typeof args === 'string' ? JSON.parse(args) : (args ?? {});
  const command = parsed.command ?? parsed.cmd ?? '';
  if (!Array.isArray(command)) return clip(command);
  // ["bash", "-lc", "npm test"] is the command "npm test".
  return /^(?:ba|z)?sh$/.test(command[0]) && command[1] === '-lc'
    ? command[2]
    : command.join(' ');
}

function codexOutput(at, raw, ref) {
  let detail = clip(raw);
  try {
    const parsed = JSON.parse(raw);
    detail = clip(parsed.output ?? raw);
    const code = parsed.metadata?.exit_code;
    if (code !== undefined) detail = `exit ${code}\n${detail}`;
  } catch {
    // Plain-text output: keep it as it came.
  }
  return { at, kind: 'output', text: detail.split('\n')[0], detail, ref };
}

function codex(line) {
  const at = line.timestamp ?? null;
  const item = line.payload ?? {};
  if (CODEX_SKIP.has(line.type)) return [];
  if (line.type === 'event_msg') {
    if (item.type === 'user_message')
      return [{ at, kind: 'prompt', text: clip(item.message) }];
    if (item.type === 'agent_message')
      return [{ at, kind: 'answer', text: clip(item.message) }];
    return [];
  }
  if (line.type !== 'response_item') return null;
  if (CODEX_ITEM_SKIP.has(item.type)) return [];
  if (item.type === 'function_call' && /shell|exec/.test(item.name)) {
    return [
      {
        at,
        kind: 'command',
        text: codexCommand(item.arguments),
        id: item.call_id,
      },
    ];
  }
  if (item.type === 'custom_tool_call' && item.name === 'apply_patch') {
    return patchFiles(item.input).map((file) => ({
      at,
      kind: 'edit',
      text: file,
      id: item.call_id,
    }));
  }
  if (item.type === 'function_call' || item.type === 'custom_tool_call') {
    return [
      {
        at,
        kind: 'tool',
        text: `${item.name} ${clip(item.arguments ?? item.input)}`,
        id: item.call_id,
      },
    ];
  }
  if (
    item.type === 'function_call_output' ||
    item.type === 'custom_tool_call_output'
  ) {
    return [
      codexOutput(
        at,
        typeof item.output === 'string'
          ? item.output
          : JSON.stringify(item.output),
        item.call_id
      ),
    ];
  }
  return null;
}

function cursor(line) {
  if (!line.role || !line.message) return null;
  return blocks(line.timestamp ?? null, line.role, line.message.content);
}

const PARSERS = { claude, codex, cursor };

/** Parse JSONL text. Returns { events, unknown } where unknown counts lines it could not read. */
export function parseTranscript(host, text) {
  const parse = PARSERS[host];
  if (!parse) throw new Error(`No transcript parser for "${host}".`);
  const events = [];
  let unknown = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let parsed = null;
    try {
      parsed = parse(JSON.parse(raw));
    } catch {
      // Not JSON, or a shape the parser cannot read: counted below.
    }
    if (parsed === null) {
      unknown += 1;
      continue;
    }
    unknown += parsed.filter((event) => event.kind === 'unknown').length;
    events.push(...parsed.filter((e) => e.text && e.kind !== 'unknown'));
  }
  return { events, unknown };
}
