import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * ONE grading rule, one name a customer types.
 *
 * `Predicate[]` travelled under three: `assertions` in the suite file,
 * `predicates` on the inline-create paths, `checks` on the case CRUD routes,
 * the UI and this spec. `check` is the survivor by explicit decision, so the
 * inline paths accept it too — and `predicates`, which was accepted here all
 * along and passed only because `EvalTestCase` allowed unknown properties, is
 * written down instead of being a third silent spelling.
 *
 * The BEHAVIOUR of that alias — folding `checks` onto the stored
 * `predicates`, and refusing a body that sends both — is covered against the
 * real routes in `eval-inline-test-vocabulary.test.ts` ("stores `checks` as
 * the case's predicate gate", "refuses both spellings of one field rather
 * than picking one") and against the published schema in
 * `openapi-alias-cardinality.test.ts`. Those arrived with the closed-object
 * work and exercise the request path end to end, so this file does not
 * duplicate them. What is left here is the half nothing else asserts: that
 * the spec NAMES the surviving spelling, and that one name which looks like a
 * synonym is deliberately not renamed.
 */
describe("the spec documents both spellings", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const spec = JSON.parse(
    readFileSync(
      resolve(here, "../../../../../docs/reference/openapi.json"),
      "utf8",
    ),
  ) as {
    components: {
      schemas: Record<
        string,
        {
          properties?: Record<
            string,
            { deprecated?: boolean; description?: string }
          >;
        }
      >;
    };
  };

  const inlineCaseProperties = [
    ["EvalTestCase", spec.components.schemas.EvalTestCase?.properties ?? {}],
    [
      "EvalSuiteCreateRequest.tests[]",
      ((
        spec.components.schemas.EvalSuiteCreateRequest?.properties as
          | Record<
              string,
              {
                items?: {
                  properties?: Record<
                    string,
                    { deprecated?: boolean; description?: string }
                  >;
                };
              }
            >
          | undefined
      )?.tests?.items?.properties ?? {}) as Record<
        string,
        { deprecated?: boolean; description?: string }
      >,
    ],
  ] as const;

  for (const [schemaName, props] of inlineCaseProperties) {
    it(`names \`checks\` on ${schemaName} and marks \`predicates\` deprecated`, () => {
      expect(props.checks).toBeDefined();
      expect(props.predicates).toBeDefined();
      // The deprecation is the whole point: both spellings are accepted, and
      // only one of them is the word a new caller should learn.
      expect(props.predicates?.deprecated).toBe(true);
      expect(props.checks?.deprecated).toBeUndefined();
    });
  }

  it("says why `steps[].assertion` is NOT renamed to a check", () => {
    // The name is earned: the field is `WidgetAssertion | Predicate`, and only
    // the Predicate half can be re-derived from a persisted transcript.
    const assertion = (spec.components.schemas.EvalTestStep?.properties ?? {})
      .assertion as { description?: string } | undefined;
    expect(assertion?.description).toMatch(/WidgetAssertion \| Predicate/);
    expect(assertion?.description).toMatch(/replay/i);
  });
});
