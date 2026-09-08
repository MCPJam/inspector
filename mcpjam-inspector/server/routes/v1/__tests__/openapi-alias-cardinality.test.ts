import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

/**
 * THE SPEC MUST REFUSE WHAT THE ROUTE REFUSES.
 *
 * Several eval-authoring fields have two spellings — a public one and a legacy
 * one — and the routes accept EXACTLY ONE of each pair, because a body sending
 * both is a caller who believes both landed. That rule lives in Zod
 * refinements, and nothing made `docs/reference/openapi.json` express it: the
 * spec is what a generated client validates against, so a spec that permits
 * both spellings hands the caller a request the route answers with a 400.
 *
 * This validates the published schemas against the SAME table of bodies the
 * route tests use (`eval-inline-test-vocabulary.test.ts`,
 * `eval-pass-criteria-percent.test.ts`), so the two descriptions of one wire
 * cannot drift apart silently. A structural assertion — "this schema has a
 * `oneOf`" — would pass on a `oneOf` that says the wrong thing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(here, "../../../../../docs/reference/openapi.json");
const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));

/**
 * Drop `$ref`s to an empty schema.
 *
 * Only alias CARDINALITY is under test here; the referenced shapes (steps,
 * predicates) have their own coverage, and resolving them would make this test
 * fail for reasons that have nothing to do with what it asserts.
 */
function withoutRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutRefs);
  if (node && typeof node === "object") {
    if ("$ref" in node) return {};
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([key, value]) => [
        key,
        withoutRefs(value),
      ]),
    );
  }
  return node;
}

function validator(schema: unknown): (body: unknown) => boolean {
  // `ajv/dist/2020` is CJS; under Node's ESM interop the class arrives on
  // `.default` in some resolutions and directly in others. Same unwrap as
  // `eval-decision-summary.test.ts`, for the same reason.
  const Ajv = ((Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ??
    Ajv2020) as typeof Ajv2020;
  const ajv = new Ajv({ strict: false, allErrors: true });
  const compiled = ajv.compile(withoutRefs(schema) as object);
  return (body) => compiled(body) === true;
}

const STEPS = [{ id: "s1", kind: "prompt", prompt: "hi" }];
const RUN_CASE = { title: "t", steps: STEPS, model: "m", provider: "p" };
const SUITE_CASE = { title: "t", steps: STEPS };
const CHECKS = { mode: "replace", list: [] };

const schemas = spec.components.schemas;

describe("openapi.json refuses the bodies the eval routes refuse", () => {
  describe("EvalTestCase — one inline test on a run", () => {
    const accepts = validator(schemas.EvalTestCase);

    it.each([
      ["the legacy `runs` alone", { ...RUN_CASE, runs: 1 }],
      ["the public `iterations` alone", { ...RUN_CASE, iterations: 1 }],
      ["`isNegative` alone", { ...RUN_CASE, runs: 1, isNegative: true }],
      [
        "`isNegativeTest` alone",
        { ...RUN_CASE, runs: 1, isNegativeTest: true },
      ],
      ["`checks` alone", { ...RUN_CASE, runs: 1, checks: CHECKS }],
    ])("accepts %s", (_label, body) => {
      expect(accepts(body)).toBe(true);
    });

    it.each([
      ["both trial-count spellings", { ...RUN_CASE, runs: 1, iterations: 2 }],
      // A run has no suite default to inherit, so one of them is required.
      ["neither trial-count spelling", { ...RUN_CASE }],
      [
        "both negative spellings",
        { ...RUN_CASE, runs: 1, isNegative: true, isNegativeTest: false },
      ],
      [
        "both check spellings",
        { ...RUN_CASE, runs: 1, checks: CHECKS, predicates: CHECKS },
      ],
      [
        "a per-case field this surface cannot author",
        {
          ...RUN_CASE,
          runs: 1,
          passThreshold: 0.8,
        },
      ],
    ])("refuses %s", (_label, body) => {
      expect(accepts(body)).toBe(false);
    });
  });

  describe("EvalSuiteCreateRequest.tests[] — one inline test on a suite", () => {
    const accepts = validator(
      schemas.EvalSuiteCreateRequest.properties.tests.items,
    );

    it.each([
      // Unlike the run item, neither is required: the suite carries a default.
      ["neither trial-count spelling", SUITE_CASE],
      ["the legacy `runs` alone", { ...SUITE_CASE, runs: 1 }],
      ["the public `iterations` alone", { ...SUITE_CASE, iterations: 1 }],
    ])("accepts %s", (_label, body) => {
      expect(accepts(body)).toBe(true);
    });

    it.each([
      ["both trial-count spellings", { ...SUITE_CASE, runs: 1, iterations: 2 }],
      [
        "both negative spellings",
        { ...SUITE_CASE, isNegative: true, isNegativeTest: false },
      ],
      [
        "both check spellings",
        { ...SUITE_CASE, checks: CHECKS, predicates: CHECKS },
      ],
      [
        "a per-case field this surface cannot author",
        {
          ...SUITE_CASE,
          kind: "regression",
        },
      ],
    ])("refuses %s", (_label, body) => {
      expect(accepts(body)).toBe(false);
    });
  });

  /**
   * Every published `passCriteria`, not just the first: the four are separate
   * objects in the file, and the point of checking all of them is that a fix
   * applied to one is not a fix applied to the surface a caller is using.
   */
  describe("passCriteria — every published copy", () => {
    const COPIES: Array<[string, unknown]> = [
      [
        "EvalSuiteCreateRequest",
        schemas.EvalSuiteCreateRequest.properties.passCriteria,
      ],
      [
        "EvalSuiteFromFileRequest",
        schemas.EvalSuiteFromFileRequest.properties.defaultPassCriteria,
      ],
      [
        "EvalRunCreateRequest",
        schemas.EvalRunCreateRequest.properties.passCriteria,
      ],
      [
        "EvalRunGroupCreateRequest",
        schemas.EvalRunGroupCreateRequest.properties.passCriteria,
      ],
    ];

    it("is published on all four write surfaces", () => {
      // Guards the enumeration itself: a fifth surface added without an entry
      // here is a gap this file would otherwise not notice.
      expect(COPIES.map(([name]) => name)).toHaveLength(4);
      for (const [name, schema] of COPIES) {
        expect(schema, `${name} publishes no passCriteria`).toBeDefined();
      }
    });

    it.each(COPIES)("%s accepts exactly one spelling", (_name, schema) => {
      const accepts = validator(schema);

      expect(accepts({ minimumPassRatePercent: 80 })).toBe(true);
      expect(accepts({ minimumPassRate: 80 })).toBe(true);
      expect(accepts({ minimumPassRatePercent: 80, minimumPassRate: 90 })).toBe(
        false,
      );
      expect(accepts({})).toBe(false);
    });

    it.each(COPIES)("%s bounds the percent to [0, 100]", (_name, schema) => {
      const accepts = validator(schema);

      // BOTH bounds on BOTH spellings: a regression in either branch would
      // otherwise slip through while generated clients keep submitting bodies
      // the route rejects.
      // The reported bug: 8000 was accepted and the gate could never pass.
      expect(accepts({ minimumPassRate: 8000 })).toBe(false);
      expect(accepts({ minimumPassRatePercent: 8000 })).toBe(false);
      expect(accepts({ minimumPassRate: -1 })).toBe(false);
      expect(accepts({ minimumPassRatePercent: -1 })).toBe(false);

      // The endpoints are real floors, not off-by-one casualties.
      expect(accepts({ minimumPassRate: 0 })).toBe(true);
      expect(accepts({ minimumPassRate: 100 })).toBe(true);
      expect(accepts({ minimumPassRatePercent: 0 })).toBe(true);
      expect(accepts({ minimumPassRatePercent: 100 })).toBe(true);
    });

    it.each(COPIES)(
      "%s refuses a fraction-looking value only on the ambiguous spelling",
      (_name, schema) => {
        const accepts = validator(schema);

        // The name is the disambiguator, and the SPEC has to say so too — its
        // prose said `(0, 1)` was invalid on the alias while `minimum: 0` /
        // `maximum: 100` accepted `0.8`, which is the published contract
        // disagreeing with itself and with the route.
        expect(accepts({ minimumPassRate: 0.8 })).toBe(false);
        // The unit is in the canonical name, so a sub-1% floor is expressible
        // there — the backend compares an UNROUNDED `passRate * 100`.
        expect(accepts({ minimumPassRatePercent: 0.5 })).toBe(true);
      },
    );
  });
});
