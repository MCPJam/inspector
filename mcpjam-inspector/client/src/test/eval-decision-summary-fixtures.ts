/**
 * The SDK's golden decision-summary corpus, read directly.
 *
 * NOT COPIED, on purpose. `sdk/tests/fixtures/eval-run-decision-summary-fixtures.json`
 * is already the shared corpus for the contract test, the API route test, the
 * Platform MCP operation test, the CLI reporters and the structured-report
 * renderers. The whole claim those five make together is that they are ONE
 * reading of a run — and a UI that asserts against its own copy of the rows
 * silently stops being part of that claim the first time the corpus is
 * regenerated. So the browser reads the same file, and a change to what a run
 * means shows up here as a failing render.
 *
 * The corpus's own LOAD RULE applies: every key beginning with `__` is a
 * fixture annotation, and every object in this contract is closed, so a
 * payload still carrying one would be rejected for the wrong reason. The
 * `expected` summaries carry none today; {@link stripAnnotations} enforces
 * that rather than assuming it.
 */
import { evalRunDecisionSummarySchema } from "@mcpjam/sdk/contract";
import type { EvalRunDecisionSummary } from "@mcpjam/sdk/contract";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CORPUS_RELATIVE_PATH =
  "sdk/tests/fixtures/eval-run-decision-summary-fixtures.json";

/**
 * Walk up from the working directory to the workspace root.
 *
 * Neither of the obvious shortcuts works here. A static `import` of the JSON
 * would hand the type checker a five-thousand-line literal type, and
 * `import.meta.url` is an `http:` URL under the jsdom environment these tests
 * run in — so the path is resolved the one way that holds however the runner
 * is invoked.
 */
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

const corpus: unknown = JSON.parse(readFileSync(locateCorpus(), "utf8"));

interface FixtureCase {
  __name: string;
  __why?: string;
  input: unknown;
  expected: unknown;
}

const CASES = (corpus as { cases: FixtureCase[] }).cases;

function stripAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAnnotations);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !key.startsWith("__"))
        .map(([key, nested]) => [key, stripAnnotations(nested)]),
    );
  }
  return value;
}

/** Every fixture's name, for `it.each` over the whole corpus. */
export function decisionSummaryFixtureNames(): string[] {
  return CASES.map((entry) => entry.__name);
}

/**
 * One fixture's expected summary, validated on the way out.
 *
 * Validating here means a test that renders a fixture is rendering something
 * the contract accepts — so a red render is about the UI, never about a
 * corpus row this build could not have read anyway.
 */
export function readDecisionSummaryFixture(
  name: string,
): EvalRunDecisionSummary {
  const entry = CASES.find((candidate) => candidate.__name === name);
  if (!entry) {
    throw new Error(
      `No decision-summary fixture named "${name}". Available: ${decisionSummaryFixtureNames().join(", ")}`,
    );
  }
  return evalRunDecisionSummarySchema.parse(stripAnnotations(entry.expected));
}

/** Every expected summary in the corpus, paired with its fixture name. */
export function readAllDecisionSummaryFixtures(): Array<
  [string, EvalRunDecisionSummary]
> {
  return CASES.map((entry) => [
    entry.__name,
    readDecisionSummaryFixture(entry.__name),
  ]);
}
