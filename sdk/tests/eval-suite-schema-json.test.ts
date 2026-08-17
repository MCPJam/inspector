/**
 * The generated JSON Schema is GENERATED — proven, not asserted.
 *
 * Three claims, each of which would otherwise rot silently:
 *
 *  1. **Both checked-in artifacts byte-match a fresh generation.** This is the
 *     `--check` mode of `generate-eval-suite-schema.ts`, run inside vitest so
 *     an ordinary `npm test` catches a hand-edit or a forgotten regeneration.
 *     It calls the same builder the CLI does, so "what CI checks" and "what the
 *     generator writes" cannot diverge.
 *  2. **The `.ts` twin and the `.json` artifact are the same document.** The
 *     package re-exports the `.ts`; the `$id` publishes the `.json`. A consumer
 *     validating against the URL and a consumer importing from the package must
 *     be validating against the same thing.
 *  3. **The schema and the zod validator agree on everything STRUCTURAL.**
 *     Every `accept` fixture compiles clean through ajv, every `__structural`
 *     reject is rejected by ajv too — and every NON-structural reject is
 *     ACCEPTED by ajv. That last one is what keeps the `__structural`
 *     annotation honest: without it, mislabelling a row as non-structural would
 *     quietly excuse it from this test forever.
 */

import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import {
  EVAL_SUITE_SCHEMA_JSON_PATH,
  EVAL_SUITE_SCHEMA_TS_PATH,
  buildEvalSuiteSchemaArtifacts,
} from "../scripts/eval-suite-schema-artifacts.js";
import { evalSuiteFileJsonSchema } from "../src/contract/eval-suite.schema.generated.js";
import { EVAL_SUITE_SCHEMA_ID } from "../src/contract/suite-file.js";
import {
  stripAnnotations,
  suiteFileFixtures as data,
} from "./support/eval-suite-fixtures.js";

// `ajv/dist/2020` is CJS; under Node's ESM interop the class arrives on
// `.default` in some resolutions and as the namespace in others.
const Ajv = ((Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ??
  Ajv2020) as typeof Ajv2020;

function compiled(): ValidateFunction {
  const ajv = new Ajv({
    // `strict` off and `logger` off for one reason: the only unknown keyword in
    // play is `format: "date-time"`, which JSON Schema defines as annotation-
    // only. Turning it into a compile error (or a console warning per run)
    // would report a schema problem where the spec says there is none.
    strict: false,
    logger: false,
  });
  return ajv.compile(evalSuiteFileJsonSchema);
}

describe("eval suite JSON Schema — generated, never hand-edited", () => {
  it("both checked-in artifacts byte-match a fresh generation", async () => {
    const artifacts = await buildEvalSuiteSchemaArtifacts();
    for (const artifact of artifacts) {
      const current = readFileSync(artifact.path, "utf8");
      expect(
        current === artifact.content,
        `${artifact.path} is stale. Run \`npm run generate:eval-suite-schema ` +
          `-w @mcpjam/sdk\` — do not hand-edit it.`
      ).toBe(true);
    }
  });

  it("the .ts twin exports exactly the .json document", () => {
    const fromJson = JSON.parse(
      readFileSync(EVAL_SUITE_SCHEMA_JSON_PATH, "utf8")
    );
    expect(evalSuiteFileJsonSchema).toEqual(fromJson);
    // And the module the package re-exports really is the generated one.
    expect(EVAL_SUITE_SCHEMA_TS_PATH.endsWith(".generated.ts")).toBe(true);
  });

  it("publishes the pinned $id and draft", () => {
    expect(evalSuiteFileJsonSchema.$id).toBe(EVAL_SUITE_SCHEMA_ID);
    expect(evalSuiteFileJsonSchema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema"
    );
  });

  it("compiles under a draft 2020-12 validator", () => {
    expect(() => compiled()).not.toThrow();
  });
});

describe("eval suite JSON Schema — agrees with zod on the structural half", () => {
  const validate = compiled();

  for (const row of data.accept) {
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

  for (const row of data.reject.filter((entry) => entry.__structural)) {
    it(`rejects (structural): ${row.__label}`, () => {
      expect(validate(stripAnnotations(row))).toBe(false);
    });
  }

  for (const row of data.reject.filter((entry) => !entry.__structural)) {
    it(`accepts (zod-only rule, not expressible here): ${row.__label}`, () => {
      // Asserted rather than skipped. A row mislabelled as non-structural would
      // otherwise be excused from this suite silently; here it fails loudly and
      // the fix is to flip the annotation.
      const ok = validate(stripAnnotations(row));
      if (!ok) {
        throw new Error(
          `"${row.__label}" is marked __structural: false, but the JSON ` +
            `Schema rejects it. Flip the annotation to true.\n` +
            JSON.stringify(validate.errors, null, 2)
        );
      }
      expect(ok).toBe(true);
    });
  }

  it("has at least one reject row of each kind", () => {
    // A cohort that drifted to all-structural would make the honesty check
    // above vacuous.
    expect(data.reject.some((row) => row.__structural)).toBe(true);
    expect(data.reject.some((row) => !row.__structural)).toBe(true);
  });
});
