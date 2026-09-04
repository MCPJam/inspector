/**
 * THE FORK GUARD for surface-core's user-value-chain vocabulary.
 *
 * `surface-core/src/copy.js` carries its own copy of three closed vocabularies
 * — the six stages, the seven failure categories and the twenty-nine stage
 * reasons — because that package has ZERO dependencies on purpose so a bot can
 * vendor the directory. A hand-maintained copy of a closed vocabulary is fine
 * exactly as long as something fails when it drifts, and the only place that
 * can compare the two is here: slack-app may depend on `@mcpjam/sdk`, and
 * surface-core may not.
 *
 * Two assertions, and both matter for different reasons:
 *
 *   MEMBERSHIP — a stage reason added to the contract and not to the fork
 *   makes the fork return `undefined` for it, and the renderer then drops the
 *   sentence. Nothing errors, nothing is printed wrong, and the surface simply
 *   stops explaining the newest kind of failure. That is the drift a diff
 *   never shows you.
 *
 *   BYTE-EQUALITY — a reason REWORDED upstream and not here leaves Slack
 *   saying one thing about a run while the CLI, the API docs and the web app
 *   say another, which is precisely the "each surface invents its own
 *   rendering" problem `decision-labels.ts` was written to end.
 *
 * When this fails: copy the SDK's value into `surface-core/src/copy.js`
 * verbatim. Do not "fix" it by loosening the comparison.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DECISION_LABEL_VOCABULARIES,
  FAILURE_CATEGORY_LABELS,
  STAGE_REASON_LABELS,
  USER_VALUE_STAGE_LABELS,
} from '@mcpjam/sdk/contract';
import { CHAIN_FAILURE_CATEGORY_LABELS, CHAIN_REASON_LABELS, CHAIN_STAGE_LABELS } from '@mcpjam/surface-core';

/** @type {Array<[string, readonly string[], Record<string,string>, Record<string,string>]>} */
const FORKS = [
  ['stages', DECISION_LABEL_VOCABULARIES.stages, CHAIN_STAGE_LABELS, USER_VALUE_STAGE_LABELS],
  [
    'failureCategories',
    DECISION_LABEL_VOCABULARIES.failureCategories,
    CHAIN_FAILURE_CATEGORY_LABELS,
    FAILURE_CATEGORY_LABELS,
  ],
  ['stageReasons', DECISION_LABEL_VOCABULARIES.stageReasons, CHAIN_REASON_LABELS, STAGE_REASON_LABELS],
];

for (const [name, vocabulary, fork, upstream] of FORKS) {
  test(`surface-core's ${name} fork is total over the contract`, () => {
    assert.deepEqual(
      Object.keys(fork).sort(),
      [...vocabulary].sort(),
      `surface-core/src/copy.js is missing or inventing a ${name} member`,
    );
  });

  test(`surface-core's ${name} fork is byte-identical to the SDK labels`, () => {
    for (const member of vocabulary) {
      assert.equal(
        fork[member],
        upstream[member],
        `${name}.${member} has drifted — copy the SDK's wording into surface-core/src/copy.js`,
      );
    }
  });
}

test('the fork covers exactly the vocabularies the chain sentence reads', () => {
  // The other two vocabularies (`stageStates`, `verdictDecisionReasons`) are
  // deliberately NOT forked: the chain sentence names a location and a reason,
  // and a state would only ever read "failed" there. Pinned so a future line
  // that starts rendering states has to add the fork and its guard together.
  assert.deepEqual(Object.keys(DECISION_LABEL_VOCABULARIES).sort(), [
    'failureCategories',
    'stageReasons',
    'stageStates',
    'stages',
    'verdictDecisionReasons',
  ]);
});
