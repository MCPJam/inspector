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
  EVAL_SUITE_SCHEMA_V2_JSON_PATH,
  EVAL_SUITE_SCHEMA_V2_TS_PATH,
  buildEvalSuiteSchemaArtifacts,
} from "../scripts/eval-suite-schema-artifacts.js";
import { evalSuiteFileJsonSchema } from "../src/contract/eval-suite.schema.generated.js";
import { evalSuiteFileV2JsonSchema } from "../src/contract/eval-suite.v2.schema.generated.js";
import {
  EVAL_SUITE_SCHEMA_ID,
  EVAL_SUITE_SCHEMA_ID_V2,
  EVAL_SUITE_SCHEMA_VERSION,
  EVAL_SUITE_SCHEMA_VERSION_2,
  evalSuiteFileSchema,
  type EvalSuiteSchemaVersion,
} from "../src/contract/suite-file.js";
import {
  findFixture,
  stripAnnotations,
  suiteFileFixtures as data,
  type SuiteFileFixtureRow,
} from "./support/eval-suite-fixtures.js";

// `ajv/dist/2020` is CJS; under Node's ESM interop the class arrives on
// `.default` in some resolutions and as the namespace in others.
const Ajv = ((Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ??
  Ajv2020) as typeof Ajv2020;

/**
 * One published document per dialect. A row is validated against ITS OWN
 * dialect's document — the one its `$id` points at — never against a union
 * of both, because no such union is published.
 */
const DIALECTS: ReadonlyArray<{
  version: EvalSuiteSchemaVersion;
  id: string;
  document: Record<string, unknown>;
  jsonPath: string;
  tsPath: string;
}> = [
  {
    version: EVAL_SUITE_SCHEMA_VERSION,
    id: EVAL_SUITE_SCHEMA_ID,
    document: evalSuiteFileJsonSchema,
    jsonPath: EVAL_SUITE_SCHEMA_JSON_PATH,
    tsPath: EVAL_SUITE_SCHEMA_TS_PATH,
  },
  {
    version: EVAL_SUITE_SCHEMA_VERSION_2,
    id: EVAL_SUITE_SCHEMA_ID_V2,
    document: evalSuiteFileV2JsonSchema,
    jsonPath: EVAL_SUITE_SCHEMA_V2_JSON_PATH,
    tsPath: EVAL_SUITE_SCHEMA_V2_TS_PATH,
  },
];

function compiled(document: Record<string, unknown>): ValidateFunction {
  const ajv = new Ajv({
    // `strict` off and `logger` off for one reason: the only unknown keyword in
    // play is `format: "date-time"`, which JSON Schema defines as annotation-
    // only. Turning it into a compile error (or a console warning per run)
    // would report a schema problem where the spec says there is none.
    strict: false,
    logger: false,
  });
  return ajv.compile(document);
}

/** The row's own dialect, read off the field the union dispatches on. */
function dialectOf(row: SuiteFileFixtureRow) {
  const dialect = DIALECTS.find((entry) => entry.version === row.schemaVersion);
  if (!dialect) {
    throw new Error(
      `"${row.__label}" declares schemaVersion ${JSON.stringify(
        row.schemaVersion
      )}, which no published document covers`
    );
  }
  return dialect;
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

  for (const dialect of DIALECTS) {
    it(`schemaVersion ${dialect.version}: the .ts twin exports exactly the .json document`, () => {
      const fromJson = JSON.parse(readFileSync(dialect.jsonPath, "utf8"));
      expect(dialect.document).toEqual(fromJson);
      // And the module the package re-exports really is the generated one.
      expect(dialect.tsPath.endsWith(".generated.ts")).toBe(true);
    });

    it(`schemaVersion ${dialect.version}: publishes the pinned $id and draft`, () => {
      expect(dialect.document.$id).toBe(dialect.id);
      expect(dialect.document.$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema"
      );
    });

    it(`schemaVersion ${dialect.version}: compiles under a draft 2020-12 validator`, () => {
      expect(() => compiled(dialect.document)).not.toThrow();
    });
  }

  it("publishes each dialect at its own $id — two documents, never a oneOf", () => {
    // Dialect 1's document is frozen so an older strict reader keeps
    // validating exactly what it always did. Folding dialect 2 into it as a
    // `oneOf` would have changed that document; a second `$id` does not.
    const ids = DIALECTS.map((dialect) => dialect.document.$id);
    expect(new Set(ids).size).toBe(DIALECTS.length);
    expect(evalSuiteFileJsonSchema.oneOf).toBeUndefined();
    expect(evalSuiteFileV2JsonSchema.oneOf).toBeUndefined();
  });

  it("constrains EVERY element locator, not just the ones the hook happened to hit", () => {
    // The locator's "at least one of role/text/css/testId" rule is a zod
    // `.refine()` and does not project, so the generator injects it. The hook
    // identifies locator nodes BY SHAPE (the refine wrapper hides the exported
    // schema object), and a detector that silently stopped matching would
    // publish an unconstrained locator with nothing failing. So walk the
    // finished document and check every locator-shaped node carries it.
    const locators: Array<Record<string, unknown>> = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      const properties = record.properties as
        | Record<string, unknown>
        | undefined;
      if (
        properties &&
        ["role", "text", "css", "testId", "nth"].every(
          (key) => key in properties
        )
      ) {
        locators.push(record);
      }
      Object.values(record).forEach(walk);
    };
    for (const dialect of DIALECTS) walk(dialect.document);

    expect(
      locators.length,
      "no locator node found — has the shape changed?"
    ).toBeGreaterThan(0);
    for (const locator of locators) {
      expect(locator.anyOf).toEqual([
        { required: ["role"] },
        { required: ["text"] },
        { required: ["css"] },
        { required: ["testId"] },
      ]);
    }
  });
});

describe("eval suite JSON Schema — agrees with zod on the structural half", () => {
  const validators = new Map(
    DIALECTS.map((dialect) => [dialect.version, compiled(dialect.document)])
  );
  const validatorFor = (row: SuiteFileFixtureRow): ValidateFunction =>
    validators.get(dialectOf(row).version)!;

  it("rejects a padded intent label at the JSON Schema boundary", () => {
    const candidate = structuredClone(stripAnnotations(data.accept[0]!)) as {
      cases: Array<Record<string, unknown>>;
    };
    candidate.cases[0]!.intent = " refund ";

    // The runtime validator rejects this through caseIntentSchema's trimmed
    // invariant. The generated JSON Schema must reject it too, otherwise a
    // schema-only producer can publish a file the SDK refuses to load.
    expect(validatorFor(data.accept[0]!)(candidate)).toBe(false);
  });

  for (const row of data.accept) {
    it(`accepts: ${row.__label}`, () => {
      const validate = validatorFor(row);
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
      // An unknown-version row has no document of its own; every published
      // document must refuse it, which is what "unknown" means.
      const candidates = DIALECTS.some((d) => d.version === row.schemaVersion)
        ? [validatorFor(row)]
        : [...validators.values()];
      for (const validate of candidates) {
        expect(validate(stripAnnotations(row))).toBe(false);
      }
    });
  }

  for (const row of data.reject.filter((entry) => !entry.__structural)) {
    it(`accepts (zod-only rule, not expressible here): ${row.__label}`, () => {
      // Asserted rather than skipped. A row mislabelled as non-structural would
      // otherwise be excused from this suite silently; here it fails loudly and
      // the fix is to flip the annotation.
      const validate = validatorFor(row);
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

  it("each dialect's document refuses the other dialect's files", () => {
    // The two documents are not a superset of each other: a dialect-2 file
    // says `iterations` where dialect 1 demands `repetitions`, and the
    // `schemaVersion` const differs. A reader validating against the wrong
    // `$id` must fail, not quietly accept a file it will then misread.
    for (const row of [...data.accept, ...data.roundTrip]) {
      const own = dialectOf(row);
      for (const other of DIALECTS) {
        if (other.version === own.version) continue;
        expect(
          validators.get(other.version)!(stripAnnotations(row)),
          `${row.__label} accepted by schemaVersion ${other.version}`
        ).toBe(false);
      }
    }
  });

  for (const label of ["minimal", "dialect 2 — minimal"]) {
    it(`agrees with zod about unknown fields — closed where closed, open where open (${label})`, () => {
      // The generator emits the INPUT shape (`io: "input"`). The default output
      // shape would describe a non-strict object as `additionalProperties:
      // false`, because zod strips before returning — publishing a schema
      // stricter than the validator it documents. Two validators disagreeing
      // about the same file is the bug; this pins both halves of the agreement.
      const row = findFixture(data.accept, label);
      const validate = validatorFor(row);
      const suite = stripAnnotations(row) as Record<string, unknown>;

      // Objects the suite file DECLARES are closed, in both validators.
      const unknownCaseField = JSON.parse(JSON.stringify(suite));
      unknownCaseField.cases[0].timeoutMs = 30_000;
      expect(validate(unknownCaseField)).toBe(false);
      expect(evalSuiteFileSchema.safeParse(unknownCaseField).success).toBe(
        false
      );

      // …and so are STEP objects, since the step union closed too. Step level is
      // where a mis-mapped import field actually lands, and it is also where the
      // Convex `v.object` mirror has always rejected — so an open schema here
      // meant an agent's mistake was dropped silently by one validator and
      // refused by the other.
      const unknownStepField = JSON.parse(JSON.stringify(suite));
      unknownStepField.cases[0].steps[0].bogusImportedField = "x";
      expect(validate(unknownStepField)).toBe(false);
      expect(evalSuiteFileSchema.safeParse(unknownStepField).success).toBe(
        false
      );

      // What stays open is what this contract does not own: the tool's own
      // argument object. Closing it would mean the suite-file schema had to know
      // every server's input schema.
      const extraToolArgument = JSON.parse(JSON.stringify(suite));
      extraToolArgument.cases[0].steps.push({
        id: "step-2",
        kind: "toolCall",
        serverName: "billing",
        toolName: "get_charge",
        arguments: { chargeId: "ch_4471", anythingTheServerDeclares: true },
      });
      expect(validate(extraToolArgument)).toBe(true);
      expect(evalSuiteFileSchema.safeParse(extraToolArgument).success).toBe(
        true
      );
    });
  }
});
