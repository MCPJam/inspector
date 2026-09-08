import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { foldInlineTestChecks } from "../evals.js";

/**
 * ONE grading rule, one name a customer types.
 *
 * `Predicate[]` travelled under three: `assertions` in the suite file,
 * `predicates` on the inline-create paths, `checks` on the case CRUD routes,
 * the UI and this spec. `check` is the survivor by explicit decision, so the
 * inline paths accept it too — and `predicates`, which was accepted here all
 * along and passed only because `EvalTestCase` allows unknown properties, is
 * now written down instead of being a third silent spelling.
 */
describe("a case's checks, under either spelling", () => {
  const gate = {
    mode: "replace" as const,
    list: [{ type: "toolCalledAtLeastOnce" as const, toolName: "echo" }],
  };

  it("folds `checks` onto the internal `predicates`", () => {
    const folded = foldInlineTestChecks({ title: "echo works", checks: gate });
    expect(folded.predicates).toEqual(gate);
    expect(folded).not.toHaveProperty("checks");
  });

  it("leaves a body that only sent `predicates` untouched", () => {
    const test = { title: "echo works", predicates: gate };
    expect(foldInlineTestChecks(test)).toBe(test);
  });

  it("refuses both spellings, rather than picking one", () => {
    // Two gates are two different gradings of one case. Choosing silently
    // would score it against rules its author cannot see in the body.
    expect(() =>
      foldInlineTestChecks({
        title: "echo works",
        checks: gate,
        predicates: gate,
      }),
    ).toThrow(/echo works/);
  });
});

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
        { properties?: Record<string, { deprecated?: boolean }> }
      >;
    };
  };

  it("names `checks` on EvalTestCase and marks `predicates` deprecated", () => {
    const props = spec.components.schemas.EvalTestCase?.properties ?? {};
    expect(props.checks).toBeDefined();
    expect(props.predicates).toBeDefined();
    expect(props.predicates?.deprecated).toBe(true);
    expect(props.checks?.deprecated).toBeUndefined();
  });

  it("says why `steps[].assertion` is NOT renamed to a check", () => {
    // The name is earned: the field is `WidgetAssertion | Predicate`, and only
    // the Predicate half can be re-derived from a persisted transcript.
    const assertion = (spec.components.schemas.EvalTestStep?.properties ?? {})
      .assertion as { description?: string } | undefined;
    expect(assertion?.description).toMatch(/WidgetAssertion \| Predicate/);
    expect(assertion?.description).toMatch(/replay/i);
  });
});
