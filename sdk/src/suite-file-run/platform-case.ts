/**
 * A resolved suite-file case, as the hosted platform would store it.
 *
 * Local execution materializes cases through the SAME conversion hosted
 * corpus materialization uses (`evalTestFromPlatformCase`), so a case grades
 * locally with the assertions, ordering and hosted-only refusals it would get
 * hosted. That function reads a `PlatformEvalCase`; this is the one place a
 * suite-file case becomes one.
 *
 * Every resolved field is mapped deliberately — the mapping mirrors the CLI's
 * `fileCaseToCreateBody` (what `mcpjam cloud eval run --file` sends), minus
 * the wire-only details: the count's floor/exact key pair collapses to the one
 * configured count, and timestamps are `null` because the case was never
 * stored. A field the conversion cannot carry is refused in preflight, never
 * dropped here.
 */

import type {
  PlatformEvalCase,
  PlatformEvalStep,
  PublicCheckOverride,
} from "../platform/types.js";
import type { ResolvedEvalSuiteFileCase } from "../suite-file-loader.js";

export function platformCaseFromSuiteFileCase(
  testCase: ResolvedEvalSuiteFileCase
): PlatformEvalCase {
  const checks: PublicCheckOverride | undefined =
    testCase.assertions.length > 0
      ? {
          mode: "replace",
          // The same predicate list the platform stores; `evalTestFromPlatformCase`
          // parses every entry with the real predicate schema.
          list: [...testCase.assertions] as PublicCheckOverride["list"],
        }
      : undefined;
  return {
    ...(testCase.judge === undefined ? {} : { judge: testCase.judge }),
    id: testCase.id,
    // The authored id IS the declared identity; there is no platform row id.
    declaredId: testCase.id,
    title: testCase.title,
    ...(testCase.intent !== undefined ? { intent: testCase.intent } : {}),
    ...(testCase.kind !== undefined ? { kind: testCase.kind } : {}),
    // The canonical step union, verbatim: a suite file's steps ARE the
    // platform's steps (`contract/suite-file.ts` reuses `stepsSchema`).
    steps: testCase.steps as unknown as PlatformEvalStep[],
    ...(testCase.expectedOutput !== undefined
      ? { expectedOutput: testCase.expectedOutput }
      : {}),
    passThreshold: testCase.passThreshold,
    isNegative: testCase.isNegativeTest,
    models: [
      {
        model: testCase.model,
        ...(testCase.provider !== undefined
          ? { provider: testCase.provider }
          : {}),
      },
    ],
    ...(testCase.suppressedSuiteStandardCheckIds !== undefined
      ? {
          suppressedSuiteStandardCheckIds: [
            ...testCase.suppressedSuiteStandardCheckIds,
          ],
        }
      : {}),
    ...(testCase.import !== undefined ? { import: testCase.import } : {}),
    iterations: testCase.iterations,
    ...(checks ? { checks } : {}),
    createdAt: null,
    updatedAt: null,
  };
}
