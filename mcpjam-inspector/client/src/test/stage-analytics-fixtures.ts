/**
 * The SDK's golden stage-analytics document, read directly.
 *
 * NOT COPIED, for the same reason `eval-decision-summary-fixtures.ts` is not:
 * `sdk/tests/fixtures/stage-analytics-golden.json` is the shared corpus, and a
 * UI that asserts against its own copy silently stops being part of that claim
 * the first time the contract changes. A change to what a stage funnel MEANS
 * has to show up here as a failing render.
 *
 * The variations below are built FROM the golden document and each is
 * re-validated with the refined schema, so a fixture can never drift into
 * asserting a shape the contract would reject.
 */
import { evalStageAnalyticsSchema } from "@mcpjam/sdk/contract";
import type { EvalStageAnalyticsV1 } from "@mcpjam/sdk/contract";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CORPUS_RELATIVE_PATH = "sdk/tests/fixtures/stage-analytics-golden.json";

/** Walk up to the workspace root — see the decision-summary reader for why. */
function locateCorpus(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(directory, CORPUS_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    `Could not find ${CORPUS_RELATIVE_PATH} above ${process.cwd()}. The UI ` +
      `asserts against the SDK's corpus directly and must not fall back to a copy.`,
  );
}

/** The golden document, validated on load with the REFINED schema. */
export const GOLDEN_STAGE_ANALYTICS: EvalStageAnalyticsV1 =
  evalStageAnalyticsSchema.parse(
    JSON.parse(readFileSync(locateCorpus(), "utf8")),
  ) as EvalStageAnalyticsV1;

/**
 * A variation of the golden document, re-validated.
 *
 * The validation is the point: the golden document carries no truncation, no
 * mixed versions and no `discovery` setup row, so those states must be BUILT —
 * and a hand-built document that no longer satisfies the contract would make
 * every assertion drawn from it meaningless.
 */
export function stageAnalyticsVariation(
  overrides: Partial<EvalStageAnalyticsV1>,
): EvalStageAnalyticsV1 {
  const draft = {
    ...structuredClone(GOLDEN_STAGE_ANALYTICS),
    ...overrides,
  };
  return evalStageAnalyticsSchema.parse(draft) as EvalStageAnalyticsV1;
}
