/**
 * The execution-budget contract: the table, the resolver, and the authored
 * schemas.
 *
 * Every case here is driven by `tests/fixtures/execution-budgets-parity.json`,
 * which `mcpjam-backend` loads VERBATIM against its hand-mirrored
 * `convex/lib/executionBudgets.ts`. Assertions that are not fixture-driven are
 * the ones that cannot cross the repo boundary — the zod error shape, the
 * object identity of the exported tables — and are marked as such.
 *
 * The fixture is the contract; adding a case here without adding it there
 * proves only that this side agrees with itself.
 */
import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/execution-budgets-parity.json" with { type: "json" };
import {
  EXECUTION_BUDGET_CEILINGS,
  EXECUTION_BUDGET_DEFAULTS,
  RESOLVED_EXECUTION_BUDGET_FIELDS,
  UNIT_TIMEOUT_FIELD,
  evalExecutionBudgetsSchema,
  lowerExecutionBudgetCeilings,
  platformExecutionBudgetCeilings,
  platformExecutionBudgetDefaults,
  resolveExecutionBudgets,
  resolveExecutionBudgetsForSurface,
  resolvedExecutionBudgetsSchema,
  swarmExecutionBudgetsSchema,
  type AuthoredExecutionBudgets,
  type ExecutionBudgetSurface,
  type ResolvedValues,
} from "../../src/contract/execution-budgets.js";

type ResolveCase = {
  __label: string;
  args: {
    surface: ExecutionBudgetSurface;
    authored?: Record<string, number>;
    ceilingOverride?: Partial<ResolvedValues>;
  };
  expect:
    | { ok: true; resolved: Record<string, unknown> }
    | {
        ok: false;
        violations: Array<{ field: string; value: number; ceiling: number }>;
      };
};

type CeilingOverrideCase = {
  __label: string;
  surface: ExecutionBudgetSurface;
  override: Partial<ResolvedValues> | null;
  expect: ResolvedValues;
};

type SchemaCase = {
  __label: string;
  surface: ExecutionBudgetSurface;
  value: Record<string, unknown>;
};

const table = fixtures.table as {
  defaults: Record<ExecutionBudgetSurface, ResolvedValues>;
  ceilings: Record<ExecutionBudgetSurface, ResolvedValues>;
  unitField: Record<ExecutionBudgetSurface, string>;
};
const resolveCases = fixtures.resolve as unknown as ResolveCase[];
const ceilingCases =
  fixtures.ceilingOverride as unknown as CeilingOverrideCase[];
const schemaCases = fixtures.authoredSchema as unknown as {
  accept: SchemaCase[];
  reject: SchemaCase[];
};

const SURFACES: ExecutionBudgetSurface[] = ["evals", "swarms"];

function schemaFor(surface: ExecutionBudgetSurface) {
  return surface === "evals"
    ? evalExecutionBudgetsSchema
    : swarmExecutionBudgetsSchema;
}

describe("execution budgets — platform table", () => {
  it.each(SURFACES)("%s defaults match the fixture", (surface) => {
    expect(EXECUTION_BUDGET_DEFAULTS[surface]).toEqual(table.defaults[surface]);
  });

  it.each(SURFACES)("%s ceilings match the fixture", (surface) => {
    expect(EXECUTION_BUDGET_CEILINGS[surface]).toEqual(table.ceilings[surface]);
  });

  it.each(SURFACES)("%s names its own unit field", (surface) => {
    expect(UNIT_TIMEOUT_FIELD[surface]).toBe(table.unitField[surface]);
  });

  it.each(SURFACES)("%s default is never above its ceiling", (surface) => {
    // A default above its ceiling would make every unauthored run refuse
    // itself — the one table error no individual resolve case would catch.
    for (const field of RESOLVED_EXECUTION_BUDGET_FIELDS) {
      expect(EXECUTION_BUDGET_DEFAULTS[surface][field]).toBeLessThanOrEqual(
        EXECUTION_BUDGET_CEILINGS[surface][field]
      );
    }
  });

  it("refuses a write to the exported tables themselves", () => {
    // Not fixture-driven: freezing has no JSON spelling. These are exported
    // from a published package, so without this a consumer could assign to
    // `EXECUTION_BUDGET_DEFAULTS.evals.runTimeoutMs` and move the clocks of
    // every later run in the process.
    expect(Object.isFrozen(EXECUTION_BUDGET_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(EXECUTION_BUDGET_CEILINGS)).toBe(true);
    for (const surface of SURFACES) {
      expect(Object.isFrozen(EXECUTION_BUDGET_DEFAULTS[surface])).toBe(true);
      expect(Object.isFrozen(EXECUTION_BUDGET_CEILINGS[surface])).toBe(true);
    }
  });

  it("hands out copies, not the live table", () => {
    // Not fixture-driven: a caller that mutated the returned object would
    // rewrite the platform defaults for every later run in the process.
    const first = platformExecutionBudgetDefaults("evals");
    first.runTimeoutMs = 1;
    expect(platformExecutionBudgetDefaults("evals").runTimeoutMs).toBe(
      table.defaults.evals.runTimeoutMs
    );
    expect(EXECUTION_BUDGET_DEFAULTS.evals.runTimeoutMs).toBe(
      table.defaults.evals.runTimeoutMs
    );
  });
});

describe("execution budgets — resolver", () => {
  it.each(resolveCases.map((c) => [c.__label, c] as const))(
    "%s",
    (_label, testCase) => {
      const result = resolveExecutionBudgets({
        ...(testCase.args.authored
          ? { authored: testCase.args.authored as AuthoredExecutionBudgets }
          : {}),
        defaults: table.defaults[testCase.args.surface],
        ceilings: lowerExecutionBudgetCeilings(
          table.ceilings[testCase.args.surface],
          testCase.args.ceilingOverride
        ),
      });

      if (testCase.expect.ok) {
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.resolved).toEqual(testCase.expect.resolved);
        // Anything the resolver produces must survive the validator every
        // snapshot read goes through, or a frozen budget could not be read
        // back.
        expect(
          resolvedExecutionBudgetsSchema.safeParse(result.resolved).success
        ).toBe(true);
      } else {
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.violations).toEqual(testCase.expect.violations);
      }
    }
  );

  it("resolves the same values through the surface-bound helper", () => {
    for (const surface of SURFACES) {
      expect(resolveExecutionBudgetsForSurface({ surface })).toEqual(
        resolveExecutionBudgets({
          defaults: table.defaults[surface],
          ceilings: table.ceilings[surface],
        })
      );
    }
  });

  it("never resolves a value above the effective ceiling, authored or not", () => {
    // The invariant behind the capped-default fixture rows: whatever rung a
    // value came from, an `ok` resolution must satisfy the ceiling it was
    // resolved against — otherwise the ceiling is not one.
    for (const surface of SURFACES) {
      const ceilings = lowerExecutionBudgetCeilings(table.ceilings[surface], {
        runTimeoutMs: 60_000,
        unitTimeoutMs: 60_000,
        turnTimeoutMs: 10_000,
        toolCallTimeoutMs: 1_000,
        turnRetries: 0,
      });
      const result = resolveExecutionBudgets({
        defaults: table.defaults[surface],
        ceilings,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const field of RESOLVED_EXECUTION_BUDGET_FIELDS) {
        if (field === "toolCallTimeoutMs") {
          expect(result.resolved).not.toHaveProperty(field);
          expect(result.resolved.sources).not.toHaveProperty(field);
          continue;
        }
        expect(result.resolved[field]).toBeLessThanOrEqual(ceilings[field]);
        // Capped, not re-labelled: the provenance union is closed.
        expect(result.resolved.sources[field]).toBe("default");
      }
    }
  });

  it("refuses rather than clamping", () => {
    // The review criterion stated as an assertion: an over-ceiling value must
    // never appear in a resolved object, in any form.
    const result = resolveExecutionBudgets({
      authored: { iterationTimeoutMs: 7_200_001 },
      defaults: table.defaults.evals,
      ceilings: table.ceilings.evals,
    });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("resolved");
  });

  it("ignores the other surface's unit word through the bound helper", () => {
    // TypeScript's discriminated union makes this unreachable, and the
    // `.strict()` authored schema refuses it at every write boundary. This
    // pins what a JavaScript caller that reached the resolver without either
    // gets: the swarm default, NOT an eval field silently running as a swarm
    // session budget.
    const resolved = resolveExecutionBudgetsForSurface({
      surface: "swarms",
      authored: { iterationTimeoutMs: 61_000 } as never,
    });
    expect(resolved.ok && resolved.resolved.unitTimeoutMs).toBe(
      table.defaults.swarms.unitTimeoutMs
    );
    expect(resolved.ok && resolved.resolved.sources.unitTimeoutMs).toBe(
      "default"
    );
  });

  it("does not read an authored key the other surface owns", () => {
    // The resolver takes no surface argument — it reads whichever unit key is
    // present. A swarm object handed the eval column must therefore still
    // resolve its own word, and must not silently pick up the other one.
    const asSwarm = resolveExecutionBudgets({
      authored: { sessionTimeoutMs: 61_000 },
      defaults: table.defaults.swarms,
      ceilings: table.ceilings.swarms,
    });
    expect(asSwarm.ok && asSwarm.resolved.unitTimeoutMs).toBe(61_000);
    expect(asSwarm.ok && asSwarm.resolved.sources.unitTimeoutMs).toBe(
      "authored"
    );
  });
});

describe("execution budgets — org ceilings lower, never raise", () => {
  it.each(ceilingCases.map((c) => [c.__label, c] as const))(
    "%s",
    (_label, testCase) => {
      expect(
        lowerExecutionBudgetCeilings(
          table.ceilings[testCase.surface],
          testCase.override ?? undefined
        )
      ).toEqual(testCase.expect);
      expect(
        platformExecutionBudgetCeilings(
          testCase.surface,
          testCase.override ?? undefined
        )
      ).toEqual(testCase.expect);
    }
  );

  it("ignores a non-finite override rather than poisoning a ceiling", () => {
    // Not fixture-driven: `NaN` has no JSON spelling. A ceiling of NaN makes
    // every `value > ceiling` comparison false, which would silently accept
    // every authored value — the exact opposite of what an operator asked for.
    const effective = lowerExecutionBudgetCeilings(table.ceilings.evals, {
      runTimeoutMs: Number.NaN,
    } as Partial<ResolvedValues>);
    expect(effective).toEqual(table.ceilings.evals);
  });
});

describe("execution budgets — authored schemas", () => {
  it.each(schemaCases.accept.map((c) => [c.__label, c] as const))(
    "accepts %s",
    (_label, testCase) => {
      const parsed = schemaFor(testCase.surface).safeParse(testCase.value);
      expect(parsed.success).toBe(true);
    }
  );

  it.each(schemaCases.reject.map((c) => [c.__label, c] as const))(
    "rejects %s",
    (_label, testCase) => {
      const parsed = schemaFor(testCase.surface).safeParse(testCase.value);
      expect(parsed.success).toBe(false);
    }
  );

  it("bounds every authored field at its platform ceiling", () => {
    // Pins the §3.2 invariant that makes parsing a first line of defence: a
    // field whose schema `max` drifted above its ceiling would accept a value
    // only the resolver could refuse, moving a clear parse error to a later,
    // vaguer boundary.
    const atCeiling = {
      evals: {
        turnTimeoutMs: table.ceilings.evals.turnTimeoutMs,
        toolCallTimeoutMs: table.ceilings.evals.toolCallTimeoutMs,
        iterationTimeoutMs: table.ceilings.evals.unitTimeoutMs,
        runTimeoutMs: table.ceilings.evals.runTimeoutMs,
        turnRetries: table.ceilings.evals.turnRetries,
      },
      swarms: {
        turnTimeoutMs: table.ceilings.swarms.turnTimeoutMs,
        toolCallTimeoutMs: table.ceilings.swarms.toolCallTimeoutMs,
        sessionTimeoutMs: table.ceilings.swarms.unitTimeoutMs,
        runTimeoutMs: table.ceilings.swarms.runTimeoutMs,
        turnRetries: table.ceilings.swarms.turnRetries,
      },
    } as const;

    for (const surface of SURFACES) {
      const schema = schemaFor(surface);
      expect(schema.safeParse(atCeiling[surface]).success).toBe(true);
      for (const [key, value] of Object.entries(atCeiling[surface])) {
        expect(
          schema.safeParse({ ...atCeiling[surface], [key]: value + 1 }).success
        ).toBe(false);
      }
    }
  });
});
