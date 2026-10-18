/**
 * The approval model of the engineering flow: pure functions over a task
 * record, so the CLI, the hooks and the tests share one meaning of approved.
 *
 * An approval stores the revision it approved and holds only while that
 * revision is current. A spec edited after sign-off is therefore no longer
 * approved, without anyone having to remember to reopen it.
 */

export const CLI = 'node scripts/eng/cli.mjs';
export const DOC_KINDS = [
  'product-spec',
  'engineering-spec',
  'plan',
  'ui-diff',
  'review',
];
export const DISPOSITIONS = ['accepted', 'rejected', 'deferred'];

export const newTask = (key, url = null) => ({
  key,
  url,
  branches: [],
  docs: {},
  approvals: {},
  reviews: [],
  history: [],
});

const log = (task, at, event, detail) =>
  task.history.push({ at, event, ...detail });

export function currentRevision(task, artifact) {
  if (artifact === 'specs') {
    const product = task.docs['product-spec']?.revision;
    const engineering = task.docs['engineering-spec']?.revision;
    return product && engineering ? `${product}+${engineering}` : null;
  }
  return task.docs.plan?.revision ?? null;
}

export function isApproved(task, artifact) {
  const approval = task.approvals[artifact];
  if (!approval || approval.revision !== currentRevision(task, artifact)) {
    return false;
  }
  // A plan approved against other specs no longer describes the agreed work.
  return (
    artifact === 'specs' ||
    (isApproved(task, 'specs') &&
      approval.specsRevision === currentRevision(task, 'specs'))
  );
}

/** The latest plan review made after the specs it reviewed against were approved. */
export function planReview(task) {
  const specsAt = task.approvals.specs?.at ?? '';
  return task.reviews.findLast((review) => review.at >= specsAt) ?? null;
}

/** Why `artifact` cannot be approved yet, or null when it can. */
export function approvalBlocker(task, artifact) {
  if (artifact === 'specs') {
    return currentRevision(task, 'specs')
      ? null
      : 'Record the product spec and the engineering spec first.';
  }
  if (artifact !== 'plan') {
    throw new Error(`Unknown approval "${artifact}". Use specs or plan.`);
  }
  if (!isApproved(task, 'specs')) return 'Approve the specs before the plan.';
  if (!currentRevision(task, 'plan')) return 'Record the plan first.';
  const review = planReview(task);
  if (!review) {
    return 'Run the fresh-agent plan review and record its findings first.';
  }
  const open = review.findings.filter(
    (finding) => !DISPOSITIONS.includes(finding.disposition)
  );
  return open.length
    ? `Record a disposition for review findings ${open.map((f) => f.id).join(', ')}.`
    : null;
}

export function approve(task, artifact, { by, at }) {
  const blocker = approvalBlocker(task, artifact);
  if (blocker) throw new Error(blocker);
  const revision = currentRevision(task, artifact);
  task.approvals[artifact] = {
    revision,
    specsRevision: currentRevision(task, 'specs'),
    by,
    at,
  };
  log(task, at, 'approved', { artifact, revision, by });
  return task;
}

/** Reopening the specs reopens the plan too: it was approved against them. */
export function reopen(task, artifact, { reason, by, at }) {
  if (!['specs', 'plan'].includes(artifact)) {
    throw new Error(`Unknown approval "${artifact}". Use specs or plan.`);
  }
  if (!reason) throw new Error('Say why the approval reopens (--reason).');
  for (const name of artifact === 'specs' ? ['specs', 'plan'] : ['plan']) {
    delete task.approvals[name];
  }
  log(task, at, 'reopened', { artifact, reason, by });
  return task;
}

export function recordDoc(task, kind, { ref, revision, at }) {
  if (!DOC_KINDS.includes(kind)) {
    throw new Error(`Unknown document "${kind}". Use ${DOC_KINDS.join(', ')}.`);
  }
  if (!ref || !revision)
    throw new Error('A document needs --ref and --revision.');
  if (task.docs[kind]?.revision !== revision) {
    log(task, at, 'document', { kind, ref, revision });
  }
  task.docs[kind] = { ref, revision, at };
  return task;
}

/** `findings` from the fresh reviewer, each with the author's disposition. */
export function recordReview(task, { revision, findings, at }) {
  if (!revision) throw new Error('Name the plan revision that was reviewed.');
  const rows = findings.map((finding, index) => ({
    id: finding.id ?? `F${index + 1}`,
    text: String(finding.text ?? ''),
    disposition: finding.disposition ?? null,
    note: finding.note ?? '',
  }));
  task.reviews.push({ revision, at, findings: rows });
  log(task, at, 'reviewed', { revision, findings: rows.length });
  return task;
}

/**
 * A scenario is settled when it passed, or was left unverified on purpose
 * with a note saying why. Any failure sends the effort back to build.
 */
const settled = (s) =>
  s.result === 'passed' || (s.result === 'unverified' && Boolean(s.note));

export function stage(task) {
  if (!isApproved(task, 'specs')) return 'specs';
  if (!isApproved(task, 'plan')) return 'plan';
  const scenarios = task.scenarios ?? [];
  return scenarios.length && scenarios.every(settled) ? 'review' : 'build';
}

/** The one thing the agent should do next, as a sentence it can act on. */
export function nextStep(task) {
  const current = stage(task);
  if (current === 'specs') {
    return currentRevision(task, 'specs')
      ? `Show the engineer both specs and ask for approval; record it with \`${CLI} approve specs\`.`
      : `Draft the product and engineering specs from .agents/skills/eng/templates/, save them on ${task.key}, and record each with \`${CLI} doc\`.`;
  }
  if (current === 'plan') {
    const blocker = approvalBlocker(task, 'plan');
    return blocker
      ? `${blocker} See "Plan" in .agents/skills/eng/SKILL.md.`
      : `Show the engineer the reviewed plan and ask for approval; record it with \`${CLI} approve plan\`.`;
  }
  if (current === 'review') {
    return 'Every scenario is settled. Assemble the review page and the PR body; see "Review package" in .agents/skills/eng/SKILL.md.';
  }
  const failed = (task.scenarios ?? []).filter((s) => s.result === 'failed');
  if (failed.length) {
    return `Scenario ${failed.map((s) => s.id).join(', ')} failed: fix the build, then verify again with \`${CLI} scenario\`.`;
  }
  return `Build to the approved plan. Log each consequential decision with \`${CLI} decision\`, and record each acceptance scenario's result with \`${CLI} scenario\`.`;
}
