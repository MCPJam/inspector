/**
 * The session record: one Kestral document per agent session, readable top
 * to bottom. The chronology keeps one line per step; full prompts, output
 * and long answers sit in collapsed <details> blocks under their line, and
 * a long session splits into parts. What the capture could not see is
 * stated at the top, never smoothed over.
 */
const HOSTS = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
const PART_SIZE = 300;
const SHORT = 200;

/**
 * Matched against a command's first line only: a heredoc body or a script
 * passed inline mentions "test" or "commit" without running either.
 */
const TEST_COMMAND =
  /(?:^|[;&|]\s*)(?:npx |npm (?:run )?)?(?:vitest|jest|pytest|go test|node --test|test\S*|slop:check|typecheck|lint(?::ci)?|pr:check)\b/;
const COMMIT_COMMAND = /(?:^|[;&|]\s*)git commit\b/;
const firstLine = (text) => text.split('\n')[0].slice(0, 160);

const time = (at) => (at ? at.slice(11, 19) : '--:--:--');

function details(summary, text) {
  const fence = text.includes('```') ? '````' : '```';
  return `  <details><summary>${summary}</summary>\n\n${fence}\n${text}\n${fence}\n\n  </details>`;
}

function line(event, output) {
  const label = {
    prompt: 'Prompt',
    answer: 'Answer',
    command: 'Command',
    edit: 'Edit',
    tool: 'Tool',
    output: 'Output',
    decision: 'Decision',
  }[event.kind];
  const short =
    event.text.length > SHORT ? `${event.text.slice(0, SHORT)}…` : event.text;
  const shown =
    event.kind === 'command' || event.kind === 'edit' ? `\`${short}\`` : short;
  const rows = [
    `- ${time(event.at)} **${label}** ${shown.replace(/\n/g, ' ')}`,
  ];
  if (event.text.length > SHORT) rows.push(details('Full text', event.text));
  if (output)
    rows.push(
      details(
        `Output: ${output.text.slice(0, 80)}`,
        output.detail ?? output.text
      )
    );
  return rows.join('\n');
}

/** Show each output under the call it answers; an unpaired one is its own step. */
function steps(events) {
  const outputs = new Map(
    events.filter((e) => e.kind === 'output' && e.ref).map((e) => [e.ref, e])
  );
  const calls = new Set(events.map((e) => e.id).filter(Boolean));
  return events
    .filter((e) => e.kind !== 'output' || !calls.has(e.ref))
    .map((e) => line(e, e.id ? outputs.get(e.id) : undefined));
}

function captureLine({ status, note, unknown, untimed }) {
  const lines = [];
  if (status === 'unavailable')
    lines.push(
      `- Capture: unavailable, because ${note}. This record holds no transcript events.`
    );
  else if (status === 'partial')
    lines.push(
      `- Capture: partial. ${unknown} transcript line(s) could not be read, so whatever they held is missing here.`
    );
  else lines.push('- Capture: complete for every transcript line read.');
  if (note && status !== 'unavailable') lines.push(`- Note: ${note}.`);
  if (untimed)
    lines.push(
      `- Timestamps: missing for ${untimed} event(s); the host did not record them, shown as --:--:--.`
    );
  return lines;
}

/** Markdown parts for the session record. The first carries the summary. */
/** Repo-relative when inside `root`; anything else is marked as outside it. */
function shownPath(file, root) {
  if (!root) return file;
  if (file.startsWith(`${root}/`)) return file.slice(root.length + 1);
  return file.startsWith('/') ? `${file} (outside the checkout)` : file;
}

export function renderSession({ session, events, task, at, root }) {
  const commands = events
    .filter((e) => e.kind === 'command')
    .map((e) => firstLine(e.text));
  const decisions = (task.decisions ?? [])
    .filter((d) => d.at >= (session.startedAt ?? '') && d.at <= at)
    .map((d) => ({ at: d.at, kind: 'decision', text: `${d.id}: ${d.what}` }));
  const timeline = [...events, ...decisions].sort((a, b) =>
    a.at && b.at ? a.at.localeCompare(b.at) : 0
  );
  const files = [
    ...new Set(
      events
        .filter((e) => e.kind === 'edit')
        .map((e) => shownPath(e.text, root))
    ),
  ];
  const list = (items) =>
    items.length ? items.map((i) => `- \`${i}\``) : ['- None'];
  const summary = [
    `# Session record: ${HOSTS[session.host] ?? session.host} session ${session.sessionId.slice(0, 8)}`,
    '',
    `- Task: ${task.key} · Branch: ${session.branch} in ${session.repo}`,
    `- Checkpoint: ${at}; first event ${events[0]?.at ?? 'unknown'}, last ${events.at(-1)?.at ?? 'unknown'}`,
    ...captureLine(session.capture),
    '',
    '## Files changed',
    ...list(files),
    '',
    '## Commits',
    ...list(commands.filter((c) => COMMIT_COMMAND.test(c))),
    '',
    '## Checks and tests run',
    ...list(commands.filter((c) => TEST_COMMAND.test(c))),
    '',
    '## Chronology (UTC)',
  ];
  const rows = steps(timeline);
  const parts = [];
  for (let i = 0; i < Math.max(rows.length, 1); i += PART_SIZE) {
    parts.push(rows.slice(i, i + PART_SIZE));
  }
  return parts.map((chunk, index) => {
    const head =
      index === 0
        ? summary
        : [
            `# Session record, part ${index + 1} of ${parts.length}`,
            '',
            `Continues the chronology of ${task.key}'s ${session.host} session ${session.sessionId.slice(0, 8)}.`,
          ];
    return [
      ...head,
      '',
      ...(chunk.length ? chunk : ['No events captured.']),
    ].join('\n');
  });
}
