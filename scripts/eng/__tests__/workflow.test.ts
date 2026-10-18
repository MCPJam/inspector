// @vitest-environment node
import { describe, expect, test } from 'vitest';

import {
  approvalBlocker,
  approve,
  isApproved,
  newTask,
  nextStep,
  recordDoc,
  recordReview,
  reopen,
  stage,
} from '../../../scripts/eng/workflow.mjs';

const by = 'Engineer';

function specced(at = '1') {
  const task = newTask('PP-1');
  recordDoc(task, 'product-spec', { ref: 'doc-p', revision: 'p1', at });
  recordDoc(task, 'engineering-spec', { ref: 'doc-e', revision: 'e1', at });
  return task;
}

function planned() {
  const task = specced();
  approve(task, 'specs', { by, at: '2' });
  recordDoc(task, 'plan', { ref: 'doc-plan', revision: 'v1', at: '3' });
  recordReview(task, {
    revision: 'v1',
    at: '4',
    findings: [{ text: 'Missing rollback step', disposition: 'accepted' }],
  });
  recordDoc(task, 'plan', { ref: 'doc-plan', revision: 'v2', at: '5' });
  return task;
}

describe('approval order', () => {
  test('specs need both documents before approval', () => {
    const task = newTask('PP-1');
    expect(stage(task)).toBe('specs');
    expect(() => approve(task, 'specs', { by, at: '1' })).toThrow(
      /product spec and the engineering spec/
    );
    expect(nextStep(task)).toMatch(/Draft the product and engineering specs/);
  });

  test('the plan cannot be approved before the specs', () => {
    const task = specced();
    recordDoc(task, 'plan', { ref: 'doc-plan', revision: 'v1', at: '2' });
    expect(approvalBlocker(task, 'plan')).toMatch(/Approve the specs/);
  });

  test('the plan needs a review with every finding dispositioned', () => {
    const task = specced();
    approve(task, 'specs', { by, at: '2' });
    recordDoc(task, 'plan', { ref: 'doc-plan', revision: 'v1', at: '3' });
    expect(approvalBlocker(task, 'plan')).toMatch(/fresh-agent plan review/);
    recordReview(task, {
      revision: 'v1',
      at: '4',
      findings: [
        { text: 'No rollout step' },
        { text: 'Fine', disposition: 'rejected' },
      ],
    });
    expect(approvalBlocker(task, 'plan')).toMatch(/findings F1\./);
    task.reviews[0].findings[0].disposition = 'deferred';
    expect(approvalBlocker(task, 'plan')).toBeNull();
  });

  test('a review made before the specs were approved does not count', () => {
    const task = specced('1');
    recordDoc(task, 'plan', { ref: 'doc-plan', revision: 'v1', at: '1' });
    recordReview(task, { revision: 'v1', at: '1', findings: [] });
    approve(task, 'specs', { by, at: '2' });
    expect(approvalBlocker(task, 'plan')).toMatch(/fresh-agent plan review/);
  });

  test('the revised plan is what gets approved', () => {
    const task = planned();
    approve(task, 'plan', { by, at: '6' });
    expect(task.approvals.plan.revision).toBe('v2');
    expect(stage(task)).toBe('build');
  });
});

describe('revision changes', () => {
  test('a new spec revision withdraws spec and plan approval', () => {
    const task = planned();
    approve(task, 'plan', { by, at: '6' });
    recordDoc(task, 'product-spec', { ref: 'doc-p', revision: 'p2', at: '7' });
    expect(isApproved(task, 'specs')).toBe(false);
    expect(stage(task)).toBe('specs');
    approve(task, 'specs', { by, at: '8' });
    // Approved against the old specs, so it does not come back on its own.
    expect(isApproved(task, 'plan')).toBe(false);
  });

  test('reopening the specs reopens the plan and records why', () => {
    const task = planned();
    approve(task, 'plan', { by, at: '6' });
    expect(() => reopen(task, 'specs', { by, at: '7' })).toThrow(/--reason/);
    reopen(task, 'specs', { reason: 'Scope grew', by, at: '7' });
    expect(task.approvals).toEqual({});
    expect(task.history.at(-1)).toMatchObject({
      event: 'reopened',
      artifact: 'specs',
      reason: 'Scope grew',
    });
  });

  test('recording the same revision again is not a new history entry', () => {
    const task = specced();
    const entries = task.history.length;
    recordDoc(task, 'product-spec', { ref: 'doc-p', revision: 'p1', at: '9' });
    expect(task.history).toHaveLength(entries);
  });
});
