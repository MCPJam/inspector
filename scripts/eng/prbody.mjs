/**
 * The PR body, built from the repository's own PR template so every
 * section the template has is filled and none is invented. The record fills
 * what it knows (task, spec and plan links, acceptance criteria from the
 * scenarios, verification evidence, screenshots); the agent supplies the
 * prose sections as a JSON object keyed by section slug. A section with no
 * value is an error, not an empty heading. Line one links the review page.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { requireTask } from './effort.mjs';
import { CLI, isApproved, planReview } from './workflow.mjs';

export const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Template sections in order: { level, heading, slug, content }. */
export function sections(template) {
  const out = [];
  for (const line of template.split('\n')) {
    const match = /^(#{2,3}) (.+)$/.exec(line);
    if (match)
      out.push({
        level: match[1],
        heading: match[2].trim(),
        slug: slug(match[2]),
        content: [],
      });
    else out.at(-1)?.content.push(line);
  }
  return out;
}

const docRef = (task, kind) => {
  const doc = task.docs[kind];
  return doc ? `${doc.ref} (revision ${doc.revision})` : null;
};

/** Values the record can fill without the agent. */
export function recordValues(task, ui) {
  const approval = (name) =>
    isApproved(task, name)
      ? `approved by ${task.approvals[name].by}`
      : 'not approved';
  const review = planReview(task);
  const scenarios = task.scenarios ?? [];
  return {
    'task-spec-and-plan': [
      `- **Kestral task:** ${task.key}${task.url ? ` (${task.url})` : ''}`,
      `- **Spec:** product spec ${docRef(task, 'product-spec') ?? 'not recorded'} and engineering spec ${docRef(task, 'engineering-spec') ?? 'not recorded'}, ${approval('specs')}`,
      `- **Plan:** ${docRef(task, 'plan') ?? 'not recorded'}, ${approval('plan')} after a fresh-agent review (${review ? `${review.findings.length} finding(s)` : 'none recorded'})`,
    ].join('\n'),
    'acceptance-criteria': scenarios.length
      ? scenarios
          .map(
            (s) =>
              `- [${s.result === 'passed' ? 'x' : ' '}] ${s.text}${s.result === 'passed' ? '' : ` (${s.result}${s.note ? `: ${s.note}` : ''})`}`
          )
          .join('\n')
      : null,
    verification: scenarios.some((s) => s.evidence)
      ? scenarios
          .filter((s) => s.evidence)
          .map(
            (s) =>
              `- ${s.id} ${s.result}: ${s.evidence.ref} (at ${s.evidence.commit}${s.evidence.dirty ? ', uncommitted changes' : ''})`
          )
          .join('\n')
      : null,
    'screenshots-and-recordings':
      ui?.impact === 'none'
        ? 'None: no UI change'
        : task.docs['ui-diff']
          ? `UI diff with current, proposed and actual screenshots: ${docRef(task, 'ui-diff')}`
          : null,
  };
}

/** Fill `template`. `fields` (from the agent) win over record values, except verification, which they extend. */
export function fillTemplate(template, { reviewUrl, values, fields }) {
  const missing = [];
  const body = [`**Review page:** ${reviewUrl}`, ''];
  for (const section of sections(template)) {
    let value = fields[section.slug] ?? values[section.slug];
    if (
      section.slug === 'verification' &&
      values.verification &&
      fields.verification
    ) {
      value = `${values.verification}\n\n${fields.verification}`;
    }
    if (!value && section.slug === 'checklist') {
      value = section.content
        .join('\n')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
    }
    if (!value) missing.push(section.slug);
    body.push(
      `${section.level} ${section.heading}`,
      '',
      String(value ?? '').trim(),
      ''
    );
  }
  if (missing.length) {
    throw new Error(
      `The PR template has sections with no value: ${missing.join(', ')}. Add them to the --fields JSON, keyed by those names; use the template's own "None: ..." wording where a section does not apply.`
    );
  }
  return body.join('\n').trimEnd();
}

export const prBodyCommands = {
  'pr-body': (effort, { flags }) => {
    requireTask(effort);
    if (!flags['review-url']) {
      throw new Error(
        `Save the review page first (\`${CLI} review-page\`), then pass its URL: --review-url <url>.`
      );
    }
    const template = readFileSync(
      join(effort.co.root, '.github/pull_request_template.md'),
      'utf8'
    );
    const fields = flags.fields
      ? JSON.parse(readFileSync(flags.fields, 'utf8'))
      : {};
    const values = recordValues(effort.task, effort.task.ui);
    return fillTemplate(template, {
      reviewUrl: flags['review-url'],
      values,
      fields,
    });
  },
};
