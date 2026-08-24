/**
 * The generated verdict-policy JSON Schema is GENERATED — proven, not asserted.
 *
 * Same three claims as `eval-suite-schema-json.test.ts`, for the second
 * published schema:
 *
 *  1. **Both checked-in artifacts byte-match a fresh generation.** This is the
 *     `--check` mode of `generate-eval-verdict-policy-schema.ts`, run inside
 *     vitest so an ordinary `npm test` catches a hand-edit or a forgotten
 *     regeneration.
 *  2. **The `.ts` twin and the `.json` artifact are the same document.** The
 *     package re-exports the `.ts`; the `$id` publishes the `.json`.
 *  3. **The schema and the zod validator agree on everything STRUCTURAL.**
 *     Every `accept` fixture passes ajv, every `__structural` reject fails it —
 *     and every NON-structural reject PASSES ajv. That last direction is what
 *     keeps the annotation honest: an arithmetic rule mislabelled as structural
 *     would otherwise be quietly excused from the zod-only cohort forever.
 */

import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import {
  EVAL_VERDICT_POLICY_SCHEMA_JSON_PATH,
  EVAL_VERDICT_POLICY_SCHEMA_TS_PATH,
  buildEvalVerdictPolicySchemaArtifacts,
} from "../scripts/eval-verdict-policy-schema-artifacts.js";
import { evalVerdictPolicyJsonSchema } from "../src/contract/eval-verdict-policy.schema.generated.js";
import {
  EVAL_VERDICT_POLICY_SCHEMA_ID,
  evalVerdictDecisionSchema,
} from "../src/contract/verdict-policy.js";
import {
  rowsOfKind,
  stripAnnotations,
  verdictPolicyFixtures as data,
} from "./support/eval-verdict-policy-fixtures.js";

// `ajv/dist/2020` is CJS; under Node's ESM interop the class arrives on
// `.default` in some resolutions and as the namespace in others.
const Ajv = ((Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ??
  Ajv2020) as typeof Ajv2020;

function compiled(): ValidateFunction {
  const ajv = new Ajv({ strict: false, logger: false });
  return ajv.compile(evalVerdictPolicyJsonSchema);
}

describe("verdict policy JSON Schema — generated, never hand-edited", () => {
  it("both checked-in artifacts byte-match a fresh generation", async () => {
    const artifacts = await buildEvalVerdictPolicySchemaArtifacts();
    for (const artifact of artifacts) {
      const current = readFileSync(artifact.path, "utf8");
      expect(
        current === artifact.content,
        `${artifact.path} is stale. Run \`npm run ` +
          `generate:eval-verdict-policy-schema -w @mcpjam/sdk\` — do not ` +
          `hand-edit it.`
      ).toBe(true);
    }
  });

  it("the .ts twin exports exactly the .json document", () => {
    const fromJson = JSON.parse(
      readFileSync(EVAL_VERDICT_POLICY_SCHEMA_JSON_PATH, "utf8")
    );
    expect(evalVerdictPolicyJsonSchema).toEqual(fromJson);
    expect(EVAL_VERDICT_POLICY_SCHEMA_TS_PATH.endsWith(".generated.ts")).toBe(
      true
    );
  });

  it("publishes the pinned $id and draft, and compiles", () => {
    expect(evalVerdictPolicyJsonSchema.$id).toBe(EVAL_VERDICT_POLICY_SCHEMA_ID);
    expect(evalVerdictPolicyJsonSchema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema"
    );
    expect(() => compiled()).not.toThrow();
  });

  it("pins the version as a const rather than defaulting it", () => {
    // The one field whose absence must never be filled in: a row with no
    // `verdictPolicyVersion` is a legacy percent-threshold row, and a `default`
    // here would let a URL-fetching validator quietly relabel it as v2.
    const properties = evalVerdictPolicyJsonSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.verdictPolicyVersion?.const).toBe(2);
    expect(properties.verdictPolicyVersion?.default).toBeUndefined();
    expect(
      (evalVerdictPolicyJsonSchema.required as string[]).includes(
        "verdictPolicyVersion"
      )
    ).toBe(true);
    expect(evalVerdictPolicyJsonSchema.additionalProperties).toBe(false);
  });
});

describe("verdict policy JSON Schema — agrees with zod on the structural half", () => {
  const validate = compiled();
  const decisions = (cohort: typeof data.accept) =>
    rowsOfKind(cohort, "decision");

  for (const row of decisions(data.accept)) {
    it(`accepts: ${row.__label}`, () => {
      const ok = validate(stripAnnotations(row));
      if (!ok) {
        throw new Error(
          `JSON Schema rejected an accept fixture "${row.__label}":\n` +
            JSON.stringify(validate.errors, null, 2)
        );
      }
      expect(ok).toBe(true);
    });
  }

  for (const row of decisions(data.reject).filter(
    (entry) => entry.__structural
  )) {
    it(`rejects (structural): ${row.__label}`, () => {
      expect(validate(stripAnnotations(row))).toBe(false);
    });
  }

  for (const row of decisions(data.reject).filter(
    (entry) => !entry.__structural
  )) {
    it(`accepts (zod-only rule, not expressible here): ${row.__label}`, () => {
      // Asserted rather than skipped: a row mislabelled as non-structural would
      // otherwise be excused from this suite silently.
      const ok = validate(stripAnnotations(row));
      if (!ok) {
        throw new Error(
          `"${row.__label}" is marked __structural: false, but the JSON ` +
            `Schema rejects it. Flip the annotation to true.\n` +
            JSON.stringify(validate.errors, null, 2)
        );
      }
      expect(ok).toBe(true);
      // …and zod still refuses it, which is the whole point of the split.
      expect(
        evalVerdictDecisionSchema.safeParse(stripAnnotations(row)).success
      ).toBe(false);
    });
  }

  it("has at least one decision reject row of each kind", () => {
    const rows = decisions(data.reject);
    expect(rows.some((row) => row.__structural)).toBe(true);
    expect(rows.some((row) => !row.__structural)).toBe(true);
  });
});
