import { describe, expect, it } from "vitest";
import { ALL_OPERATIONS } from "@mcpjam/sdk/platform";
import { updateSuiteSchema } from "../evals.js";
import { EVAL_SUITE_SETTINGS_MANIFEST } from "@/shared/eval-suite-settings-manifest";

/**
 * The API half of the settings-parity ratchet.
 *
 * The manifest claims, for each settings-sheet row, how an agent reaches it.
 * A claim nobody checks is worse than no claim: it reads as coverage while the
 * field it names was renamed, moved, or never added. So every `api:` path is
 * exercised against the REAL PATCH schema with a value of the right shape, and
 * every `op:` is resolved against the real operation catalog.
 *
 * Its companion
 * (`client/src/components/evals/__tests__/suite-settings-manifest.test.tsx`)
 * checks the other direction: that every rendered row has an entry, and that
 * no entry outlived its row.
 */

/**
 * A body that exercises one dotted `api:` path, and nothing else.
 *
 * Values are per-path because the schema is typed: a generic placeholder would
 * be rejected everywhere and the test would pass by failing for the wrong
 * reason. Any path added to the manifest without a sample here fails loudly
 * below rather than being skipped.
 */
const SAMPLE_BY_PATH: Readonly<Record<string, unknown>> = {
  // S1 — the name moved into the sheet, so the manifest claims it and the
  // PATCH schema has to actually accept it.
  name: "Renamed",
  "settings.minimumAccuracy": 80,
  "settings.minimumIterations": 3,
  "settings.matchOptions": { toolCallOrder: "exact" },
  "settings.checks": [{ type: "responseContains", needle: "hi" }],
  "settings.judge": { enabled: true, autoRun: true, threshold: 0.8 },
  // S6 — the suite's judge criteria, nested under the judge on the wire.
  "settings.judge.rubric": {
    criteria: [{ id: "cites", label: "Cites a source" }],
  },
  // B9b — the v2 verdict policy. FRACTIONS: `passThreshold: 0.8` is the same
  // bar `minimumAccuracy: 80` sets in the other unit, which is why the schema
  // refuses the two together.
  "settings.repetitions": 3,
  "settings.passThreshold": 0.8,
  "settings.validity": { minCompletionRate: 0.9 },
  "environment.computerEnvironment": "Playwright",
  environmentIds: ["env_1"],
};

/** Build `{a: {b: value}}` from `"a.b"`. */
function bodyForPath(path: string, value: unknown): Record<string, unknown> {
  const segments = path.split(".");
  return segments.reduceRight<unknown>(
    (inner, key) => ({ [key]: inner }),
    value
  ) as Record<string, unknown>;
}

const OPERATION_NAMES = new Set(ALL_OPERATIONS.map((op) => op.name));

describe("eval suite settings manifest — API parity", () => {
  it("declares exactly one reachability answer per row", () => {
    for (const row of EVAL_SUITE_SETTINGS_MANIFEST) {
      const answers = [row.api, row.op, row.excluded].filter(
        (value) => value !== undefined
      );
      expect(answers, `${row.key} must declare exactly one answer`).toHaveLength(
        1
      );
    }
  });

  it("uses a unique key per row", () => {
    const keys = EVAL_SUITE_SETTINGS_MANIFEST.map((row) => row.key);
    expect(keys).toEqual([...new Set(keys)]);
  });

  it("accepts every `api:` path on the public PATCH schema", () => {
    const unreachable: string[] = [];
    for (const row of EVAL_SUITE_SETTINGS_MANIFEST) {
      if (!row.api) continue;
      const sample = SAMPLE_BY_PATH[row.api];
      expect(
        sample,
        `${row.key} names api path "${row.api}" with no sample value in this test — add one`
      ).toBeDefined();
      const parsed = updateSuiteSchema.safeParse(
        bodyForPath(row.api, sample)
      );
      if (!parsed.success) {
        unreachable.push(`${row.key} → ${row.api}: ${parsed.error.message}`);
        continue;
      }
      // The schema is strict at the top level, so an unknown key is a
      // rejection rather than a silent strip. Still assert the declared
      // head survived parse — a future non-strict regression would otherwise
      // pass this test while dropping the field.
      const [head] = row.api.split(".");
      expect(
        parsed.data,
        `${row.key} → ${row.api} parsed but was dropped from the result`
      ).toHaveProperty(head);
    }
    expect(
      unreachable,
      `Manifest rows claiming a PATCH field the schema does not accept:\n  ${unreachable.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("preserves the leaf of every nested `api:` path", () => {
    // `settings.judge` reaching the schema tells us nothing if `judge.autoRun`
    // is silently dropped inside it — which is the exact failure the LLM as
    // Judge gap was.
    for (const row of EVAL_SUITE_SETTINGS_MANIFEST) {
      if (!row.api || !row.api.includes(".")) continue;
      const [head, leaf] = row.api.split(".");
      const parsed = updateSuiteSchema.parse(
        bodyForPath(row.api, SAMPLE_BY_PATH[row.api])
      ) as Record<string, Record<string, unknown>>;
      expect(
        parsed[head],
        `${row.key} → ${row.api} lost its leaf "${leaf}"`
      ).toHaveProperty(leaf);
    }
  });

  it("names a real platform operation for every `op:` row", () => {
    for (const row of EVAL_SUITE_SETTINGS_MANIFEST) {
      if (!row.op) continue;
      expect(
        OPERATION_NAMES.has(row.op),
        `${row.key} names operation "${row.op}", which is not in ALL_OPERATIONS`
      ).toBe(true);
    }
  });

  it("gives every `excluded:` row a substantive reason", () => {
    // Short reasons are how an exclusion becomes permanent: nobody can argue
    // with "not supported".
    for (const row of EVAL_SUITE_SETTINGS_MANIFEST) {
      if (!row.excluded) continue;
      expect(
        row.excluded.trim().length,
        `${row.key}'s exclusion reason is too thin to argue with`
      ).toBeGreaterThanOrEqual(40);
    }
  });
});
