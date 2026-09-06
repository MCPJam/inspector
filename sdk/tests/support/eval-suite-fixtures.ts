/**
 * Loader for the shared eval-suite-file parity fixtures.
 *
 * A plain module, not a test file: both `eval-suite-file.test.ts` (zod) and
 * `eval-suite-schema-json.test.ts` (ajv) read the same rows, and importing one
 * test file from another would re-register its `describe`s in the importer and
 * report every case twice.
 *
 * The strip rule lives here too, for the same reason it is spelled out in the
 * fixture's `__readme`: every object in this contract is closed, so a payload
 * still carrying `__label` would be rejected for the wrong reason — turning an
 * accept row into a false failure and a reject row into a false success.
 */

import fixtures from "../fixtures/eval-suite-parity-fixtures.json" with { type: "json" };

export type SuiteFileFixtureRow = Record<string, unknown> & {
  __kind: "suiteFile";
  __label: string;
  __why?: string;
  /**
   * Whether the GENERATED JSON Schema must reject this row too, or whether it
   * is a cross-field rule only the zod validator can express.
   */
  __structural?: boolean;
};

export type SuiteFileFixtures = {
  __readme: string;
  accept: SuiteFileFixtureRow[];
  reject: SuiteFileFixtureRow[];
  roundTrip: SuiteFileFixtureRow[];
};

export const suiteFileFixtures = fixtures as unknown as SuiteFileFixtures;

/** Strip every `__`-prefixed annotation, recursively. */
export function stripAnnotations<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripAnnotations(entry)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (key.startsWith("__")) continue;
      out[key] = stripAnnotations(entry);
    }
    return out as unknown as T;
  }
  return value;
}

/** The validator-ready payload for one fixture row. */
export function suiteFilePayload(row: SuiteFileFixtureRow): unknown {
  return stripAnnotations(row);
}

/** The one row whose `__label` starts with `labelPrefix`, or a loud failure. */
export function findFixture(
  cohort: SuiteFileFixtureRow[],
  labelPrefix: string
): SuiteFileFixtureRow {
  const row = cohort.find((entry) => entry.__label.startsWith(labelPrefix));
  if (!row) {
    throw new Error(`missing eval-suite fixture "${labelPrefix}"`);
  }
  return row;
}
