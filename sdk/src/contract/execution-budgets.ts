/**
 * Execution budgets — one clock vocabulary for evals and swarms.
 *
 * Before this module every timeout on both surfaces was a module constant: the
 * eval iteration cap (10 min), the eval run cap (20 min), the swarm's absence
 * of any cap at all. Nothing was tunable, and — worse — nothing was *named*, so
 * a timed-out unit could only report "aborted" and a reader could not tell
 * which clock had fired.
 *
 * The contract here is deliberately small and pure:
 *
 *   - An AUTHORED shape (what a suite or swarm stores) where every field is
 *     optional; absent means "use the platform default".
 *   - A RESOLVED shape (what a launch freezes into the run snapshot) where
 *     every field is present, plus per-field provenance in `sources`.
 *   - One pure {@link resolveExecutionBudgets} that turns the first into the
 *     second against a defaults table and a ceiling table, and REFUSES rather
 *     than clamping when an authored value is above its ceiling.
 *
 * Two rules the rest of the program leans on:
 *
 * **Refuse, don't clamp.** A run must never execute with a different number
 * from the one its author wrote. A violation is returned as data (field, value,
 * ceiling) so each boundary can raise its own error —
 * `EXECUTION_BUDGET_EXCEEDS_CEILING` as a `ConvexError` in the backend, a 422
 * on the v1 API — while the *decision* stays here, in one place.
 *
 * **One decision, persisted.** Resolution happens ONCE, at launch, and the
 * result is frozen into the run snapshot. Runners read the snapshot; they never
 * re-derive from live suite config, so editing a suite mid-run cannot move the
 * clocks of a run already in flight.
 *
 * `unitTimeoutMs` exists only on the RESOLVED shape: it is `iterationTimeoutMs`
 * for evals and `sessionTimeoutMs` for swarms, which lets every runtime consumer
 * share one field name while authors keep the word that means something on
 * their surface. Authors never see "unit".
 *
 * Milliseconds everywhere. Minutes exist only in rendering.
 *
 * This file is the CANONICAL copy. `convex/lib/executionBudgets.ts` in
 * mcpjam-backend is a hand mirror (the backend cannot import `@mcpjam/sdk` into
 * Convex default-runtime code), kept honest by
 * `sdk/tests/fixtures/execution-budgets-parity.json`, which both sides load
 * verbatim.
 */
import { z } from "zod";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * The fields both surfaces share, with the bounds any authored value must
 * satisfy before it is even considered against a ceiling.
 *
 * Each `max` here is the PLATFORM ceiling for that field (§3.2), so a value the
 * platform could never run is refused by parsing alone. The ceiling check in
 * {@link resolveExecutionBudgets} is what catches an ORG ceiling that lowers the
 * platform one — and is defence in depth for callers that reach the resolver
 * with an unparsed object.
 */
export const executionBudgetCoreShape = {
  /** One assistant turn, including the tool steps it drives. */
  turnTimeoutMs: z
    .number()
    .int()
    .min(10_000)
    .max(30 * MINUTE_MS)
    .optional(),
  /** One MCP request. A host-pinned per-server override still wins over this. */
  toolCallTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(10 * MINUTE_MS)
    .optional(),
  /** The whole run. A backstop, not the working bound. */
  runTimeoutMs: z
    .number()
    .int()
    .min(MINUTE_MS)
    .max(12 * HOUR_MS)
    .optional(),
  /** AI SDK `maxRetries` for one model call. Never applied to a live stream. */
  turnRetries: z.number().int().min(0).max(5).optional(),
} as const;

/** Budgets as an eval suite authors them. */
export const evalExecutionBudgetsSchema = z
  .object({
    ...executionBudgetCoreShape,
    /** One trial: the unit that, from PR 2 on, fails alone. */
    iterationTimeoutMs: z
      .number()
      .int()
      .min(30_000)
      .max(2 * HOUR_MS)
      .optional(),
  })
  .strict();

/** Budgets as a swarm or journey authors them. */
export const swarmExecutionBudgetsSchema = z
  .object({
    ...executionBudgetCoreShape,
    /** One synthetic session against one target. */
    sessionTimeoutMs: z
      .number()
      .int()
      .min(MINUTE_MS)
      .max(2 * HOUR_MS)
      .optional(),
  })
  .strict();

export type EvalExecutionBudgets = z.infer<typeof evalExecutionBudgetsSchema>;
export type SwarmExecutionBudgets = z.infer<typeof swarmExecutionBudgetsSchema>;
export type AuthoredExecutionBudgets =
  EvalExecutionBudgets | SwarmExecutionBudgets;

/** Which surface a defaults/ceilings column belongs to. */
export type ExecutionBudgetSurface = "evals" | "swarms";

/** Policy fields; toolCallTimeoutMs is reserved until runtime integration. */
export type ResolvedExecutionBudgetField =
  | "turnTimeoutMs"
  | "toolCallTimeoutMs"
  | "unitTimeoutMs"
  | "runTimeoutMs"
  | "turnRetries";

export const RESOLVED_EXECUTION_BUDGET_FIELDS = [
  "turnTimeoutMs",
  "toolCallTimeoutMs",
  "unitTimeoutMs",
  "runTimeoutMs",
  "turnRetries",
] as const satisfies readonly ResolvedExecutionBudgetField[];

/** A complete column of the defaults/ceilings table. */
export type ResolvedValues = Record<ResolvedExecutionBudgetField, number>;
/**
 * A column nobody can edit. The platform tables are exported from a published
 * package: without this a consumer could assign to
 * `EXECUTION_BUDGET_DEFAULTS.evals.runTimeoutMs` and silently move the clocks
 * of every later run in the process. Readers take this; anything that builds a
 * column takes {@link ResolvedValues}.
 */
export type ReadonlyResolvedValues = Readonly<ResolvedValues>;
/**
 * The same type under a name that survives a package-level export.
 * `ResolvedValues` is the spelling the contract's own signatures use, and is
 * far too generic to put on `@mcpjam/sdk`'s public surface.
 */
export type ResolvedExecutionBudgetValues = ResolvedValues;

/** Which rung of the ladder supplied a resolved value. */
export type ExecutionBudgetSource = "authored" | "default";

export type ResolvedExecutionBudgets = Omit<
  ResolvedValues,
  "toolCallTimeoutMs"
> & {
  sources: Record<
    Exclude<ResolvedExecutionBudgetField, "toolCallTimeoutMs">,
    ExecutionBudgetSource
  >;
};

/**
 * Shape of the resolved object as it is persisted into a run snapshot and read
 * back. `.strict()` on purpose: a runner must not silently ignore a sixth clock
 * some future writer added, so widening this is an explicit, reviewed change on
 * both sides of the mirror rather than something a deploy can do by accident.
 */
export const resolvedExecutionBudgetsSchema = z
  .object({
    turnTimeoutMs: z.number().int().positive(),
    // Accepted from old snapshots, but not emitted until the runtime consumes it.
    toolCallTimeoutMs: z.number().int().positive().optional(),
    unitTimeoutMs: z.number().int().positive(),
    runTimeoutMs: z.number().int().positive(),
    turnRetries: z.number().int().min(0),
    sources: z
      .object({
        turnTimeoutMs: z.enum(["authored", "default"]),
        toolCallTimeoutMs: z.enum(["authored", "default"]).optional(),
        unitTimeoutMs: z.enum(["authored", "default"]),
        runTimeoutMs: z.enum(["authored", "default"]),
        turnRetries: z.enum(["authored", "default"]),
      })
      .strict(),
  })
  .strict();

/**
 * Platform defaults, per surface (§3.2).
 *
 * Calibration: turn measured (p99.9 3.91 min, max 5.76 min); eval unit
 * measured (all-tenant max 7.74 min); eval run measured (max 19.91 min).
 * Tool-call budgets are unmeasured: MCP request-duration telemetry is absent.
 * Swarm unit and run are unmeasured (one journey run). All ceilings are
 * policy headroom, not percentiles.
 */
export const EXECUTION_BUDGET_DEFAULTS: Readonly<
  Record<ExecutionBudgetSurface, ReadonlyResolvedValues>
> = Object.freeze({
  evals: Object.freeze({
    turnTimeoutMs: 6 * MINUTE_MS,
    toolCallTimeoutMs: 30_000,
    unitTimeoutMs: 10 * MINUTE_MS,
    runTimeoutMs: 30 * MINUTE_MS,
    turnRetries: 2,
  }),
  swarms: Object.freeze({
    turnTimeoutMs: 6 * MINUTE_MS,
    toolCallTimeoutMs: 120_000,
    unitTimeoutMs: 20 * MINUTE_MS,
    runTimeoutMs: 2 * HOUR_MS,
    turnRetries: 2,
  }),
});

/**
 * Platform ceilings, per surface (§3.2). An authored value above these is
 * refused; an org may LOWER them but never raise them.
 */
export const EXECUTION_BUDGET_CEILINGS: Readonly<
  Record<ExecutionBudgetSurface, ReadonlyResolvedValues>
> = Object.freeze({
  evals: Object.freeze({
    turnTimeoutMs: 30 * MINUTE_MS,
    toolCallTimeoutMs: 10 * MINUTE_MS,
    unitTimeoutMs: 2 * HOUR_MS,
    runTimeoutMs: 12 * HOUR_MS,
    turnRetries: 5,
  }),
  swarms: Object.freeze({
    turnTimeoutMs: 30 * MINUTE_MS,
    toolCallTimeoutMs: 10 * MINUTE_MS,
    unitTimeoutMs: 2 * HOUR_MS,
    runTimeoutMs: 12 * HOUR_MS,
    turnRetries: 5,
  }),
});

/** The authored spelling of the unit clock, per surface. */
export const UNIT_TIMEOUT_FIELD = {
  evals: "iterationTimeoutMs",
  swarms: "sessionTimeoutMs",
} as const satisfies Record<ExecutionBudgetSurface, string>;

/**
 * One refused field. `field` is the AUTHORED spelling, because this is what a
 * person is shown — someone who wrote `iterationTimeoutMs` must not be told
 * their `unitTimeoutMs` is too large.
 */
export type ExecutionBudgetViolation = {
  field: string;
  value: number;
  ceiling: number;
};

export type ExecutionBudgetResolution =
  | { ok: true; resolved: ResolvedExecutionBudgets }
  | { ok: false; violations: ExecutionBudgetViolation[] };

/** The error code every boundary raises for a ceiling violation. */
export const EXECUTION_BUDGET_EXCEEDS_CEILING =
  "EXECUTION_BUDGET_EXCEEDS_CEILING";

function authoredUnit(
  authored: AuthoredExecutionBudgets | undefined
): { field: string; value: number } | undefined {
  if (!authored) return undefined;
  const iteration = (authored as EvalExecutionBudgets).iterationTimeoutMs;
  if (typeof iteration === "number") {
    return { field: UNIT_TIMEOUT_FIELD.evals, value: iteration };
  }
  const session = (authored as SwarmExecutionBudgets).sessionTimeoutMs;
  if (typeof session === "number") {
    return { field: UNIT_TIMEOUT_FIELD.swarms, value: session };
  }
  return undefined;
}

/**
 * Resolve authored budgets against a defaults column and a ceiling column.
 *
 * Pure: no clock, no I/O, no surface argument. The caller's `defaults` and
 * `ceilings` already encode which surface this is; the only place the surface
 * matters here is naming the unit field in a violation, and the authored object
 * names it itself.
 *
 * `{ authored: undefined }` yields the defaults column with every source
 * `"default"` — which is exactly what a runner does for a run launched before
 * budgets were written into snapshots, so there is no legacy branch anywhere.
 */
export function resolveExecutionBudgets(args: {
  authored?: AuthoredExecutionBudgets;
  defaults: ReadonlyResolvedValues;
  ceilings: ReadonlyResolvedValues;
}): ExecutionBudgetResolution {
  const { authored, defaults, ceilings } = args;
  const unit = authoredUnit(authored);

  const authoredValues: Record<
    ResolvedExecutionBudgetField,
    { field: string; value: number } | undefined
  > = {
    turnTimeoutMs:
      typeof authored?.turnTimeoutMs === "number"
        ? { field: "turnTimeoutMs", value: authored.turnTimeoutMs }
        : undefined,
    toolCallTimeoutMs:
      typeof authored?.toolCallTimeoutMs === "number"
        ? { field: "toolCallTimeoutMs", value: authored.toolCallTimeoutMs }
        : undefined,
    unitTimeoutMs: unit,
    runTimeoutMs:
      typeof authored?.runTimeoutMs === "number"
        ? { field: "runTimeoutMs", value: authored.runTimeoutMs }
        : undefined,
    turnRetries:
      typeof authored?.turnRetries === "number"
        ? { field: "turnRetries", value: authored.turnRetries }
        : undefined,
  };

  const violations: ExecutionBudgetViolation[] = [];
  // Keys come from RESOLVED_EXECUTION_BUDGET_FIELDS — a fixed tuple of five
  // string literals — never from the caller's object, so nothing here can be
  // `__proto__` or any other caller-chosen key.
  const values = {} as ResolvedValues;
  const sources = {} as Record<
    ResolvedExecutionBudgetField,
    ExecutionBudgetSource
  >;

  for (const field of RESOLVED_EXECUTION_BUDGET_FIELDS) {
    const supplied = authoredValues[field];
    if (supplied === undefined) {
      // A default is CAPPED by the effective ceiling, not copied past it. An
      // org that lowered its ceiling below the platform default meant "cap my
      // runs here", and a suite that authored nothing must not sail over it —
      // a ceiling an unauthored run ignores is not a ceiling. This is not the
      // clamping §2.5 forbids: that rule protects a number a PERSON wrote, and
      // nobody wrote this one. The source stays "default" — that is the rung
      // it came from, and the union is closed.
      values[field] = Math.min(defaults[field], ceilings[field]);
      sources[field] = "default";
      continue;
    }
    if (supplied.value > ceilings[field]) {
      // Collect every violation rather than returning the first: a settings
      // form that raised three fields at once should be told about all three.
      violations.push({
        field: supplied.field,
        value: supplied.value,
        ceiling: ceilings[field],
      });
      continue;
    }
    values[field] = supplied.value;
    sources[field] = "authored";
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }
  const { toolCallTimeoutMs: _unusedToolBudget, ...runtimeValues } = values;
  const { toolCallTimeoutMs: _unusedToolSource, ...runtimeSources } = sources;
  return { ok: true, resolved: { ...runtimeValues, sources: runtimeSources } };
}

/**
 * Fold an operator's per-org override into the platform ceilings.
 *
 * LOWER ONLY: `effective = min(platform, org)`. Raising a ceiling above the
 * platform's is not expressible — an org column that names a larger number is
 * ignored for that field rather than refused, because the operator's intent
 * ("cap my org at X") is unambiguous and a value already below the platform
 * ceiling is a no-op either way.
 *
 * This follows the per-org-override pattern the entitlements module names for
 * `evalEvidenceRetentionDays`: a column read, not a flag payload.
 */
export function lowerExecutionBudgetCeilings(
  platform: ReadonlyResolvedValues,
  override?: Partial<ResolvedValues>
): ResolvedValues {
  if (!override) return { ...platform };
  const effective = { ...platform };
  for (const field of RESOLVED_EXECUTION_BUDGET_FIELDS) {
    const candidate = override[field];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      effective[field] = Math.min(platform[field], candidate);
    }
  }
  return effective;
}

/** Platform defaults for one surface, as a fresh object. */
export function platformExecutionBudgetDefaults(
  surface: ExecutionBudgetSurface
): ResolvedValues {
  return { ...EXECUTION_BUDGET_DEFAULTS[surface] };
}

/** Effective ceilings for one surface, after an optional org override. */
export function platformExecutionBudgetCeilings(
  surface: ExecutionBudgetSurface,
  orgOverride?: Partial<ResolvedValues>
): ResolvedValues {
  return lowerExecutionBudgetCeilings(
    EXECUTION_BUDGET_CEILINGS[surface],
    orgOverride
  );
}

/**
 * A surface paired with the budgets THAT surface can author.
 *
 * Discriminated, so `{ surface: "swarms", authored: { iterationTimeoutMs } }`
 * does not compile. `resolveExecutionBudgets` itself detects the unit field by
 * key presence — it takes no surface — which is right for a resolver that must
 * serve both, and wrong the moment a caller has already said which one it is.
 */
export type ResolveExecutionBudgetsForSurfaceArgs =
  | {
      surface: "evals";
      authored?: EvalExecutionBudgets;
      orgCeilings?: Partial<ResolvedValues>;
    }
  | {
      surface: "swarms";
      authored?: SwarmExecutionBudgets;
      orgCeilings?: Partial<ResolvedValues>;
    };

/**
 * Surface-bound convenience over {@link resolveExecutionBudgets}, so a caller
 * that just wants "eval budgets, platform table" cannot pick the wrong column —
 * or the wrong unit field.
 */
export function resolveExecutionBudgetsForSurface(
  args: ResolveExecutionBudgetsForSurfaceArgs
): ExecutionBudgetResolution {
  const authored = args.authored
    ? withoutForeignUnitField(args.authored, args.surface)
    : undefined;
  return resolveExecutionBudgets({
    ...(authored ? { authored } : {}),
    defaults: platformExecutionBudgetDefaults(args.surface),
    ceilings: platformExecutionBudgetCeilings(args.surface, args.orgCeilings),
  });
}

/**
 * Drop the OTHER surface's unit field, so it can never become this surface's
 * unit budget.
 *
 * Belt and braces: the union above makes this unreachable from TypeScript, and
 * the `.strict()` authored schemas refuse the foreign key outright at every
 * write boundary — which is where a person actually finds out they used the
 * wrong word. This only stops a JavaScript caller that reached the resolver
 * without either, and it drops the field rather than resolving it, because
 * quietly running a swarm session on a number labelled `iterationTimeoutMs`
 * is the worse of the two wrongs.
 */
function withoutForeignUnitField(
  authored: AuthoredExecutionBudgets,
  surface: ExecutionBudgetSurface
): AuthoredExecutionBudgets {
  const foreign =
    surface === "evals" ? UNIT_TIMEOUT_FIELD.swarms : UNIT_TIMEOUT_FIELD.evals;
  if (!(foreign in authored)) return authored;
  const copy = { ...authored } as Record<string, unknown>;
  delete copy[foreign];
  return copy as AuthoredExecutionBudgets;
}
