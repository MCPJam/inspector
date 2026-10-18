/**
 * The review page: one short Kestral document a reviewer reads before the
 * diff. It links the approved specs and plan, lays out the decision
 * timeline and plan versus actual, shows the acceptance evidence with the
 * commit each result was verified at, and ends with what is unresolved and
 * what never reached Kestral. Everything comes from the local record, so
 * the page says plainly where that record is incomplete.
 */
import { readFileSync } from 'node:fs';

import { requireTask } from './effort.mjs';
import { enqueue, pending } from './outbox.mjs';
import { changeTaskFor } from './sync.mjs';
import { git, list, read } from './state.mjs';
import { uiGaps } from './ui.mjs';
import { CLI, isApproved, planReview } from './workflow.mjs';

const day = (at) => (at ?? '').slice(0, 10);

function docLine(task, kind, label, approval) {
  const doc = task.docs[kind];
  if (!doc) return `- ${label}: not recorded`;
  const approved = approval
    ? `, approved by ${approval.by} on ${day(approval.at)}`
    : ', not approved';
  return `- ${label}: ${doc.ref} (revision ${doc.revision}${approved})`;
}

function specs(task) {
  const review = planReview(task);
  const counts = {};
  for (const finding of review?.findings ?? []) {
    counts[finding.disposition] = (counts[finding.disposition] ?? 0) + 1;
  }
  const tally = Object.entries(counts)
    .map(([d, n]) => `${n} ${d}`)
    .join(', ');
  const specApproval = isApproved(task, 'specs') ? task.approvals.specs : null;
  const ui =
    task.ui?.impact === 'none'
      ? '- UI diff: None: no UI change.'
      : docLine(task, 'ui-diff', 'UI diff');
  return [
    docLine(task, 'product-spec', 'Product spec', specApproval),
    docLine(task, 'engineering-spec', 'Engineering spec', specApproval),
    docLine(
      task,
      'plan',
      'Plan',
      isApproved(task, 'plan') ? task.approvals.plan : null
    ),
    `- Fresh-agent plan review: ${review ? `${review.findings.length} finding(s)${tally ? ` (${tally})` : ''}` : 'none recorded'}`,
    ui,
  ];
}

function timeline(task) {
  const rows = [
    ...task.history
      .filter((h) => h.event === 'approved' || h.event === 'reopened')
      .map((h) => ({
        at: h.at,
        text:
          h.event === 'approved'
            ? `${h.artifact} approved by ${h.by}`
            : `${h.artifact} reopened by ${h.by}: ${h.reason}`,
      })),
    ...(task.decisions ?? []).map((d) => ({
      at: d.at,
      text: `${d.id} ${d.what}: ${d.why} (${d.by})${d.supersedes ? `, supersedes ${d.supersedes}` : ''}${d.supersededBy ? `, superseded by ${d.supersededBy}` : ''}${d.longLived ? '; flagged long-lived for a person to promote' : ''}`,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return rows.length
    ? rows.map((r) => `- ${day(r.at)} ${r.text}`)
    : ['- None recorded'];
}

/** How far `commit` is behind HEAD, as text, or '' when it is HEAD. */
function behind(commit, root) {
  try {
    const count = Number(git(['rev-list', '--count', `${commit}..HEAD`], root));
    return count ? `, ${count} commit(s) before HEAD` : '';
  } catch {
    // The commit is gone (rebased away): say so instead of guessing.
    return ', no longer on this branch';
  }
}

function evidence(task, root) {
  const rows = (task.scenarios ?? []).map((s) => {
    const proof = s.evidence;
    const where = proof
      ? `${proof.commit}${behind(proof.commit, root)}${proof.dirty ? ', uncommitted changes' : ''}`
      : '-';
    const what = proof ? proof.ref : s.note || 'no evidence';
    return `| ${s.id} ${s.text} | ${s.result} | ${what.replace(/\|/g, '\\|')} | ${where} |`;
  });
  if (!rows.length) return ['No acceptance scenarios recorded.'];
  return [
    '| Scenario | Result | Evidence | Verified at |',
    '| --- | --- | --- | --- |',
    ...rows,
  ];
}

function risks(task, extra) {
  const rows = [...extra];
  for (const s of task.scenarios ?? []) {
    if (s.result !== 'passed')
      rows.push(`${s.id} is ${s.result}${s.note ? `: ${s.note}` : ''}`);
  }
  for (const f of planReview(task)?.findings ?? []) {
    if (f.disposition === 'deferred')
      rows.push(`Deferred review finding ${f.id}: ${f.text}`);
  }
  rows.push(...uiGaps(task).map((gap) => `UI diff: ${gap}`));
  return rows.length ? rows.map((r) => `- ${r}`) : ['- None known'];
}

function unsynced(co, task) {
  const items = pending(co, task.key).map(
    (i) => `- Not on Kestral yet: ${i.kind} "${i.title}"`
  );
  const sessions = list(co.dir, 'sessions')
    .map((name) => read(co.dir, name))
    .filter((s) => s.task === task.key && s.capture?.status !== 'complete')
    .map(
      (s) =>
        `- Session ${s.host} ${s.sessionId.slice(0, 8)}: capture ${s.capture?.status ?? 'never ran'}${s.capture?.note ? ` (${s.capture.note})` : ''}`
    );
  return [...items, ...sessions];
}

function changedFiles(base, root) {
  try {
    const files = git(['diff', '--name-only', `${base}...HEAD`], root);
    return `${files.split('\n').filter(Boolean).length} file(s) changed against ${base}`;
  } catch {
    // No such base here: report it rather than count against the wrong one.
    return `could not compare with ${base}; pass --base <branch below>`;
  }
}

/**
 * Markdown for the review page. `base` is the ref the branch is compared
 * with; `notes` is the agent's own plan-versus-actual summary, step by step.
 */
export function renderReview(
  effort,
  { base = 'origin/main', notes, risks: extra = [], at }
) {
  const { co, task } = effort;
  const head = git(['rev-parse', '--short', 'HEAD'], co.root);
  const branches = task.branches.map((b) => `${b.repo}:${b.branch}`).join(', ');
  const deviations = (task.ui?.deviations ?? []).map(
    (d) => `- UI deviation: ${d.text}`
  );
  const decided = (task.decisions ?? []).filter((d) => !d.supersededBy).length;
  const gaps = unsynced(co, task);
  return [
    `# Review: ${task.key}`,
    '',
    `Task: ${task.url ?? task.key} · Branches: ${branches} · Generated ${at} at ${head}`,
    '',
    '## Specs and plan',
    ...specs(task),
    '',
    '## Decision timeline',
    ...timeline(task),
    '',
    '## Plan versus actual',
    `- Built on ${co.branch}: ${changedFiles(base, co.root)}.`,
    `- ${decided} standing decision(s) record where the build departs from or refines the approved plan.`,
    ...deviations,
    ...(notes ? ['', notes.trim()] : []),
    '',
    '## Acceptance evidence',
    ...evidence(task, co.root),
    '',
    '## Unresolved risks',
    ...risks(task, extra),
    '',
    '## Not synchronized or not captured',
    ...(gaps.length
      ? gaps
      : [
          '- Nothing: every record is on Kestral and every session was captured.',
        ]),
  ].join('\n');
}

export const reviewCommands = {
  'review-page': (effort, { flags }) => {
    const key = requireTask(effort);
    const extra = flags.risk ? [flags.risk] : [];
    const notes = flags.notes ? readFileSync(flags.notes, 'utf8') : undefined;
    const at = new Date().toISOString();
    const body = renderReview(effort, {
      base: flags.base,
      notes,
      risks: extra,
      at,
    });
    const head = git(['rev-parse', '--short', 'HEAD'], effort.co.root);
    changeTaskFor(effort, (task) => {
      task.reviewPage = { at, head };
    });
    const item = enqueue(effort.co, {
      key: `review:${key}`,
      kind: 'review',
      task: key,
      title: `Review: ${key}`,
      body,
    });
    return `${body}\n\nQueued as ${item.id}. Save it on ${key}, then \`${CLI} synced ${item.id} --ref <id>\` and pass its URL to \`${CLI} pr-body --review-url\`.`;
  },
};
