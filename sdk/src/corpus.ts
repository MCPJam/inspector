/**
 * Materialize hosted eval cases into local `EvalTest`s, and lock what was
 * materialized.
 *
 * --- Where this lives, and why ---
 *
 * PURE. No `node:` imports, no `process.env`, no file I/O — that lives in
 * `cli/src/lib/corpus-lock.ts`. It is deliberately NOT under `sdk/src/platform`
 * (which is runtime-safety-ratcheted for a different reason: it ships to the
 * browser) but it holds itself to the same bar, because materialization is
 * useful anywhere a case list can be fetched.
 *
 * --- Unsupported cases fail LOUDLY ---
 *
 * A hosted case can do things a local run cannot: drive a widget, click an
 * element, call a tool directly. Silently dropping those steps would produce a
 * test that runs, passes, and measures something other than what the dashboard
 * shows — the worst outcome available. So `HostedOnlyCaseError` names the case,
 * the step index, the step id, the kind, and the fix.
 *
 * --- The lock ---
 *
 * `mcpjam-evals.lock.json` stores NORMALIZED CONTENT, not a hash alone.
 * Reproducibility wants the whole case back; drift detection wants a hash. The
 * hash is over a VERSIONED, per-kind ALLOWLIST of semantic fields — never the
 * raw wire object — so a server adding a cosmetic field does not churn every
 * hash in the file. Extending the allowlist is a `lockVersion` bump.
 */

import { EvalTest, type EvalTestConfig } from "./EvalTest.js";
import { EvalSuite } from "./EvalSuite.js";
import type { HostExecutor } from "./HostExecutor.js";
import { canonicalDigest } from "./contract/canonical.js";
import { aggregateEvaluationConfigHash } from "./contract/derive.js";
import { predicateSchema, type Predicate } from "./predicates/types.js";
import type { EvalMatchOptions } from "./matchers.js";
import type { EvalExpectedToolCall } from "./eval-reporting-types.js";
import type {
  PlatformEvalCase,
  PlatformEvalStep,
} from "./platform/types.js";

// ── errors ──────────────────────────────────────────────────────────────────

/** A case that only a hosted run can execute. Never a silent drop. */
export class HostedOnlyCaseError extends Error {
  readonly caseId: string;
  readonly caseTitle: string;
  readonly stepId?: string;
  readonly stepIndex?: number;

  constructor(args: {
    caseId: string;
    caseTitle: string;
    stepId?: string;
    stepIndex?: number;
    what: string;
    fix: string;
  }) {
    const where =
      args.stepIndex === undefined
        ? ""
        : ` at step ${args.stepIndex}${args.stepId ? ` (${args.stepId})` : ""}`;
    super(
      `Eval case "${args.caseTitle}" (${args.caseId})${where} uses ` +
        `${args.what}, which only a hosted run can execute. ${args.fix}`
    );
    this.name = "HostedOnlyCaseError";
    this.caseId = args.caseId;
    this.caseTitle = args.caseTitle;
    if (args.stepId !== undefined) this.stepId = args.stepId;
    if (args.stepIndex !== undefined) this.stepIndex = args.stepIndex;
  }
}

// ── match options ───────────────────────────────────────────────────────────

/** Public tool-call order → the SDK matcher's vocabulary. */
const ORDER_FROM_PUBLIC = {
  any: "ignore",
  "in-order": "superset",
  exact: "strict",
} as const satisfies Record<string, NonNullable<EvalMatchOptions["toolCallOrder"]>>;

export type PublicMatchOptions = {
  toolCallOrder?: keyof typeof ORDER_FROM_PUBLIC;
  extraToolCalls?: "unlimited" | number;
  arguments?: "ignore" | "partial" | "exact";
};

/**
 * Inverse of the server's public↔internal match-options table.
 *
 * Written as an exhaustive `Record` rather than a switch so adding a public
 * order value fails to COMPILE here instead of silently falling through to a
 * default that changes how every corpus case is graded.
 */
export function sdkMatchOptionsFromPublic(
  publicOptions: PublicMatchOptions | undefined
): EvalMatchOptions | undefined {
  if (!publicOptions) return undefined;
  const out: EvalMatchOptions = {};
  if (publicOptions.toolCallOrder !== undefined) {
    out.toolCallOrder = ORDER_FROM_PUBLIC[publicOptions.toolCallOrder];
  }
  if (publicOptions.extraToolCalls !== undefined) {
    out.maxExtraToolCalls =
      publicOptions.extraToolCalls === "unlimited"
        ? null
        : publicOptions.extraToolCalls;
  }
  if (publicOptions.arguments !== undefined) {
    out.argumentMatching = publicOptions.arguments;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── checks ──────────────────────────────────────────────────────────────────

export type PublicCheckOverride = {
  mode: "inherit" | "replace" | "extend";
  list: unknown[];
};

/**
 * Resolve a case's effective checks against the suite's defaults.
 *
 * Every entry is parsed with the real `predicateSchema`. A parse failure is a
 * LOUD error naming the case, the ordinal and zod's message — never a dropped
 * check, which would silently weaken the case.
 */
export function resolveEffectiveChecks(
  caseChecks: PublicCheckOverride | undefined,
  suiteChecks: unknown[] | undefined,
  context: { caseId: string; caseTitle: string }
): Predicate[] {
  const suite = suiteChecks ?? [];
  const mode = caseChecks?.mode ?? "inherit";
  const raw =
    mode === "replace"
      ? (caseChecks?.list ?? [])
      : mode === "extend"
        ? [...suite, ...(caseChecks?.list ?? [])]
        : suite;

  return raw.map((entry, ordinal) => {
    const parsed = predicateSchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error(
        `Eval case "${context.caseTitle}" (${context.caseId}) has an ` +
          `unrecognized check at position ${ordinal}: ` +
          `${parsed.error.issues.map((issue: { message: string }) => issue.message).join("; ")}`
      );
    }
    return parsed.data as Predicate;
  });
}

// ── steps ───────────────────────────────────────────────────────────────────

/** Widget assertions key on `kind`; predicates key on `type`. */
function isWidgetAssertion(assertion: unknown): boolean {
  return (
    typeof assertion === "object" &&
    assertion !== null &&
    typeof (assertion as { kind?: unknown }).kind === "string"
  );
}

function hostedOnlyStep(
  step: PlatformEvalStep,
  index: number,
  evalCase: PlatformEvalCase,
  what: string,
  fix: string
): HostedOnlyCaseError {
  return new HostedOnlyCaseError({
    caseId: evalCase.id,
    caseTitle: evalCase.title,
    stepId: step.id,
    stepIndex: index,
    what,
    fix,
  });
}

// ── content hash ────────────────────────────────────────────────────────────

/**
 * Per-kind SEMANTIC projection of a step, for the content hash.
 *
 * Explicitly enumerated per kind. Hashing the raw wire object would mean a
 * server adding a cosmetic field churns every hash in the lock file and every
 * `--frozen` check reports drift that did not happen.
 *
 * `id` is stripped: an editor row's identity is not scenario content, and
 * position already carries order. Everything included is semantic —
 * `serverId` decides which server answers, `renderTimeoutMs` decides how long
 * a widget may take, and both change what the case measures.
 */
function hashableStep(step: PlatformEvalStep): Record<string, unknown> {
  const kind = step.kind;
  switch (kind) {
    case "prompt":
      return { kind, prompt: step.prompt };
    case "assert":
      return { kind, assertion: step.assertion };
    case "toolCall":
      return {
        kind,
        serverId: step.serverId,
        serverName: step.serverName,
        toolName: step.toolName,
        arguments: step.arguments,
        renderTimeoutMs: step.renderTimeoutMs,
      };
    case "interact":
      return { kind, toolName: step.toolName, action: step.action };
    default: {
      // A kind this version does not know: hash the kind alone rather than the
      // whole object, so an unknown step still participates in drift detection
      // without dragging unknown wire fields into the digest.
      return { kind };
    }
  }
}

/** Bump when the allowlist below changes — the hash is versioned by it. */
export const CORPUS_LOCK_VERSION = 2;

/**
 * Stable digest of a case's SEMANTIC content.
 *
 * OUT, deliberately: `models` and `iterations` (execution selection and
 * sizing, not what the case says), `matchOptions` and `checks` (evaluation
 * config — covered by the lock's `evaluationConfigHash`, so a matcher edit
 * surfaces as `evaluationConfigChanged` rather than as `contentChanged`), and
 * every id and timestamp. `fetchedAt` is never hashed.
 */
export function scenarioContentHash(evalCase: PlatformEvalCase): string {
  return canonicalDigest({
    lockVersion: CORPUS_LOCK_VERSION,
    title: evalCase.title,
    isNegative: evalCase.isNegative,
    scenario: evalCase.scenario,
    expectedOutput: evalCase.expectedOutput,
    steps: (evalCase.steps ?? []).map(hashableStep),
  });
}

// ── materialization ─────────────────────────────────────────────────────────

export type EvalTestFromCaseOptions = {
  /** Suite-level checks the case may inherit or extend. */
  suiteChecks?: unknown[];
  /** Suite-level match options, used when the case has none. */
  suiteMatchOptions?: PublicMatchOptions;
  /** Display name override — identity still rides `externalCaseId`. */
  name?: string;
};

/**
 * Build one `EvalTest` from a hosted case.
 *
 * The generated `test()` replays the case's prompt steps in order and returns
 * `true`. That is not "the test always passes": the verdict comes from the
 * projections — tool-match, predicates, and any scorers — and `test()`'s own
 * legacy score is one input among them. A generated body cannot assert
 * anything the hosted case did not already declare.
 */
export function evalTestFromPlatformCase(
  evalCase: PlatformEvalCase,
  options: EvalTestFromCaseOptions = {}
): EvalTest {
  const steps = evalCase.steps ?? [];
  if (steps.length === 0) {
    throw new Error(
      `Eval case "${evalCase.title}" (${evalCase.id}) has no steps, so there ` +
        `is nothing to run locally.`
    );
  }

  const prompts: string[] = [];
  const expectedToolCalls: EvalExpectedToolCall[] = [];
  const stepPredicates: Predicate[] = [];

  steps.forEach((step, index) => {
    switch (step.kind) {
      case "prompt": {
        const prompt = typeof step.prompt === "string" ? step.prompt : "";
        if (prompt.trim() === "") {
          throw new Error(
            `Eval case "${evalCase.title}" (${evalCase.id}) has an empty ` +
              `prompt at step ${index}.`
          );
        }
        prompts.push(prompt);
        return;
      }
      case "toolCall":
        throw hostedOnlyStep(
          step,
          index,
          evalCase,
          "a direct toolCall step",
          "Replace it with a prompt that causes the tool to be called, or run this case hosted."
        );
      case "interact":
        throw hostedOnlyStep(
          step,
          index,
          evalCase,
          "a widget interact step",
          "Widget interaction needs the hosted headless browser; run this case hosted."
        );
      case "assert": {
        if (isWidgetAssertion(step.assertion)) {
          throw hostedOnlyStep(
            step,
            index,
            evalCase,
            "a widget assertion",
            "Widget assertions need hosted render observations; run this case hosted."
          );
        }
        const parsed = predicateSchema.safeParse(step.assertion);
        if (!parsed.success) {
          throw new Error(
            `Eval case "${evalCase.title}" (${evalCase.id}) has an ` +
              `unrecognized assertion at step ${index}: ` +
              `${parsed.error.issues.map((issue: { message: string }) => issue.message).join("; ")}`
          );
        }
        const predicate = parsed.data as Predicate;
        // `toolCalledWith` becomes an expectation rather than a predicate, so
        // it grades through the tool matcher exactly as the hosted
        // `deriveExpectedToolCalls` does. `minCount` and per-assert matching
        // are dropped IDENTICALLY on both sides — this is parity, not loss.
        if (predicate.type === "toolCalledWith") {
          // A negative case passes only when NO tool was called, so ANY
          // `toolCalledWith` contradicts it. Checked here rather than on the
          // derived `expectedToolCalls`, because a non-plain assertion stays a
          // predicate below and would otherwise slip past: the matcher would
          // demand no calls while the predicate demanded one, failing every
          // iteration for a reason the author never wrote.
          if (evalCase.isNegative) {
            throw new Error(
              `Eval case "${evalCase.title}" (${evalCase.id}) is a negative ` +
                `case (passes only when NO tool is called) but asserts ` +
                `toolCalledWith at step ${index}. Those cannot both hold. ` +
                `Fix the case in the dashboard, or run it hosted.`
            );
          }
          // Convert to an EXPECTATION only when the assertion carries nothing
          // the expectation cannot express. `expectedToolCalls` has no
          // `minCount` and no per-call `argumentMatching`, so converting an
          // assertion that uses either would grade it more loosely than the
          // dashboard does — a local pass where hosted fails.
          //
          // Anything else stays a PREDICATE, which is not a fallback: the
          // predicate engine evaluates `toolCalledWith` locally with full
          // fidelity, including both fields. The conversion exists only for
          // parity with hosted `deriveExpectedToolCalls` on the plain case.
          const minCount = predicate.minCount;
          const argumentMatching = predicate.args?.argumentMatching;
          const isPlain =
            (minCount === undefined || minCount === 1) &&
            (argumentMatching === undefined || argumentMatching === "partial");
          if (isPlain) {
            expectedToolCalls.push({
              toolName: predicate.toolName,
              arguments: predicate.args?.args ?? {},
            });
            return;
          }
        }
        stepPredicates.push(predicate);
        return;
      }
      default:
        throw hostedOnlyStep(
          step,
          index,
          evalCase,
          `an unsupported step kind "${String(step.kind)}"`,
          "Upgrade @mcpjam/sdk, or run this case hosted."
        );
    }
  });

  if (prompts.length === 0) {
    throw new Error(
      `Eval case "${evalCase.title}" (${evalCase.id}) has no prompt steps, so ` +
        `there is nothing to send to the agent.`
    );
  }

  // Step predicates first, then effective checks. Stable order matters: a
  // predicate's generated scorer id is POSITIONAL, so reordering renumbers
  // every downstream score row.
  const predicates = [
    ...stepPredicates,
    ...resolveEffectiveChecks(
      evalCase.checks as PublicCheckOverride | undefined,
      options.suiteChecks,
      { caseId: evalCase.id, caseTitle: evalCase.title }
    ),
  ];

  const matchOptions =
    sdkMatchOptionsFromPublic(
      evalCase.matchOptions as PublicMatchOptions | undefined
    ) ?? sdkMatchOptionsFromPublic(options.suiteMatchOptions);

  // The contradiction check, completed over the MERGED config.
  //
  // A `toolCalledWith` reaches a case by three routes, and the per-step check
  // above sees only two of them: checks are resolved AFTER the step loop, so a
  // negative case carrying one in `checks` — its own, or inherited from the
  // suite — used to sail past. Scanning the merged arrays here is what makes
  // the guard total; the per-step throw stays because it can name the step.
  if (evalCase.isNegative) {
    // Any `toolCalledWith` still standing in `predicates` came from checks:
    // the step-predicate route threw above.
    if (predicates.some((predicate) => predicate.type === "toolCalledWith")) {
      throw new Error(
        `Eval case "${evalCase.title}" (${evalCase.id}) is a negative case ` +
          `(passes only when NO tool is called) but a toolCalledWith check ` +
          `applies to it — from the case, or inherited from the suite. Those ` +
          `cannot both hold. Fix the check in the dashboard, or run it hosted.`
      );
    }
    if (expectedToolCalls.length > 0) {
      throw new Error(
        `Eval case "${evalCase.title}" (${evalCase.id}) is a negative case ` +
          `(passes only when NO tool is called) but declares expected tool ` +
          `calls. Fix the case in the dashboard, or run it hosted.`
      );
    }
  }

  const config: EvalTestConfig = {
    // The hosted case's own id IS this case's declared identity — a
    // materialized case was already id-bearing in spirit, and minting a fresh
    // one here would give the same case two identities.
    id: evalCase.id,
    name: options.name ?? evalCase.title,
    test: async (executor: HostExecutor) => {
      for (const prompt of prompts) {
        await executor.run(prompt);
      }
      return true;
    },
    // Hosted semantics, preserved rather than translated. See EvalTestConfig.
    isNegativeTest: evalCase.isNegative,
    ...(expectedToolCalls.length > 0 ? { expectedToolCalls } : {}),
    ...(predicates.length > 0 ? { predicates } : {}),
    ...(matchOptions ? { matchOptions } : {}),
    ...(evalCase.expectedOutput !== undefined
      ? { expectedOutput: evalCase.expectedOutput }
      : {}),
    // Intent is analytics metadata, not semantic case content, but the local
    // EvalTest must still carry the hosted label onto its reported iterations.
    ...(evalCase.intent !== undefined ? { intent: evalCase.intent } : {}),
    // Identity ALWAYS rides here, never on the display name.
    externalCaseId: evalCase.id,
  };
  return new EvalTest(config);
}

// ── corpus ──────────────────────────────────────────────────────────────────

export type CorpusCase = {
  test: EvalTest;
  /** `"external:<id>"` — the caseKey the backend will derive. */
  scenarioKey: string;
  scenarioContentHash: string;
  iterations: number;
  models: PlatformEvalCase["models"];
  expectedOutput?: string;
};

export type CorpusSkip = {
  caseId: string;
  caseTitle: string;
  reason: string;
};

export type CorpusLock = {
  lockVersion: number;
  project?: string;
  suite: { id: string; name?: string };
  fetchedAt: string;
  /**
   * Suite-level inputs, persisted because a case can INHERIT them.
   *
   * Without these, `loadCorpusFromLock` rebuilds an inheriting case with no
   * suite checks and default match options — which changes its resolved
   * scorer definitions, so the rebuilt `evaluationConfigHash` differs from the
   * one recorded here and `--frozen` reports drift on a case nobody touched.
   */
  suiteChecks?: unknown[];
  suiteMatchOptions?: PublicMatchOptions;
  /** Aggregate over per-case evaluation-config hashes. Never over `fetchedAt`. */
  evaluationConfigHash: string;
  cases: Array<{
    scenarioKey: string;
    caseId: string;
    title: string;
    scenarioContentHash: string;
    evaluationConfigHash: string;
    iterations: number;
    /** The RAW wire case. Reproducibility wants everything back. */
    normalizedContent: PlatformEvalCase;
  }>;
};

export type LoadedCorpus = {
  project?: string;
  suite: { id: string; name?: string };
  cases: CorpusCase[];
  skipped: CorpusSkip[];
  lock: CorpusLock;
  toEvalSuite(): EvalSuite;
};

/**
 * Disambiguate colliding display names.
 *
 * `EvalSuite.add` rejects duplicate names, so two corpus cases sharing a title
 * would make `toEvalSuite()` throw. Every member of a colliding group gets
 * `"<title> [<caseId>]"` — deterministic (the same corpus always yields the
 * same names) and applied to the WHOLE group, so which case got the bare name
 * does not depend on fetch order. Unique titles stay bare.
 */
export function resolveCaseNames(
  cases: Array<{ id: string; title: string }>
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const entry of cases) {
    counts.set(entry.title, (counts.get(entry.title) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const entry of cases) {
    names.set(
      entry.id,
      (counts.get(entry.title) ?? 0) > 1
        ? `${entry.title} [${entry.id}]`
        : entry.title
    );
  }
  return names;
}

export type BuildCorpusInput = {
  project?: string;
  suite: { id: string; name?: string };
  cases: PlatformEvalCase[];
  suiteChecks?: unknown[];
  suiteMatchOptions?: PublicMatchOptions;
  /** `"error"` (default) refuses hosted-only cases; `"skip"` records them. */
  unsupported?: "error" | "skip";
  /** ISO timestamp for the lock. Injected so this stays pure. */
  fetchedAt: string;
};

/**
 * Materialize a fetched case list. Pure — the network half lives in the CLI.
 */
export function buildCorpus(input: BuildCorpusInput): LoadedCorpus {
  const names = resolveCaseNames(input.cases);
  const cases: CorpusCase[] = [];
  const skipped: CorpusSkip[] = [];

  for (const evalCase of input.cases) {
    let test: EvalTest;
    try {
      test = evalTestFromPlatformCase(evalCase, {
        ...(input.suiteChecks ? { suiteChecks: input.suiteChecks } : {}),
        ...(input.suiteMatchOptions
          ? { suiteMatchOptions: input.suiteMatchOptions }
          : {}),
        name: names.get(evalCase.id) ?? evalCase.title,
      });
    } catch (error) {
      // ONLY a hosted-only case may be skipped. Malformed data — an unknown
      // predicate, a case with no prompt — is a broken corpus, and silently
      // dropping it would produce a suite that looks complete and is not.
      if (
        input.unsupported === "skip" &&
        error instanceof HostedOnlyCaseError
      ) {
        skipped.push({
          caseId: evalCase.id,
          caseTitle: evalCase.title,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      throw error;
    }
    cases.push({
      test,
      scenarioKey: `external:${evalCase.id}`,
      scenarioContentHash: scenarioContentHash(evalCase),
      iterations: evalCase.iterations,
      models: evalCase.models,
      ...(evalCase.expectedOutput !== undefined
        ? { expectedOutput: evalCase.expectedOutput }
        : {}),
    });
  }

  const byKey = new Map(cases.map((entry) => [entry.scenarioKey, entry]));
  const sourceById = new Map(input.cases.map((entry) => [entry.id, entry]));

  return {
    ...(input.project !== undefined ? { project: input.project } : {}),
    suite: input.suite,
    cases,
    skipped,
    lock: buildCorpusLock({
      ...(input.project !== undefined ? { project: input.project } : {}),
      suite: input.suite,
      fetchedAt: input.fetchedAt,
      ...(input.suiteChecks ? { suiteChecks: input.suiteChecks } : {}),
      ...(input.suiteMatchOptions
        ? { suiteMatchOptions: input.suiteMatchOptions }
        : {}),
      cases: [...byKey.values()].map((entry) => ({
        entry,
        source: sourceById.get(entry.scenarioKey.slice("external:".length))!,
      })),
    }),
    toEvalSuite(): EvalSuite {
      const suite = new EvalSuite({ name: input.suite.name ?? input.suite.id });
      for (const entry of cases) suite.add(entry.test);
      return suite;
    },
  };
}

export function buildCorpusLock(args: {
  project?: string;
  suite: { id: string; name?: string };
  fetchedAt: string;
  suiteChecks?: unknown[];
  suiteMatchOptions?: PublicMatchOptions;
  cases: Array<{ entry: CorpusCase; source: PlatformEvalCase }>;
}): CorpusLock {
  // Sorted by scenarioKey so the file is byte-stable across fetches — a lock
  // that reorders on every pull is a lock nobody can review in a diff.
  // Codepoint order, NOT `localeCompare`: the default locale comes from the
  // host, so the same corpus would produce different lock BYTES on two
  // machines and every `--frozen` check would depend on where it ran.
  const rows = [...args.cases]
    .sort((left, right) =>
      left.entry.scenarioKey < right.entry.scenarioKey
        ? -1
        : left.entry.scenarioKey > right.entry.scenarioKey
          ? 1
          : 0
    )
    .map(({ entry, source }) => ({
      scenarioKey: entry.scenarioKey,
      caseId: source.id,
      title: source.title,
      scenarioContentHash: entry.scenarioContentHash,
      // The ONE existing derivation. Re-deriving definitions here would be a
      // drift factory: the lock would claim a hash the run never produces.
      evaluationConfigHash: entry.test.getEvaluationConfigSnapshot().hash,
      iterations: entry.iterations,
      normalizedContent: source,
    }));

  return {
    lockVersion: CORPUS_LOCK_VERSION,
    ...(args.project !== undefined ? { project: args.project } : {}),
    suite: args.suite,
    fetchedAt: args.fetchedAt,
    ...(args.suiteChecks ? { suiteChecks: args.suiteChecks } : {}),
    ...(args.suiteMatchOptions
      ? { suiteMatchOptions: args.suiteMatchOptions }
      : {}),
    // Same computation `EvalSuite` performs at upload, so the lock and the run
    // agree by construction rather than by coincidence.
    evaluationConfigHash: aggregateEvaluationConfigHash(
      rows.map((row) => row.evaluationConfigHash)
    ),
    cases: rows,
  };
}

export type CorpusDrift =
  | { kind: "caseAdded"; scenarioKey: string; title: string }
  | { kind: "caseRemoved"; scenarioKey: string; title: string }
  | { kind: "contentChanged"; scenarioKey: string; title: string }
  | { kind: "evaluationConfigChanged"; scenarioKey: string; title: string };

/**
 * Compare a lock against a freshly-built one.
 *
 * Content and evaluation-config drift are reported SEPARATELY for the same
 * case: "somebody edited the prompt" and "somebody changed the matcher" have
 * different fixes, and collapsing them into one "changed" hides which.
 */
export function verifyCorpusLock(
  locked: CorpusLock,
  fresh: CorpusLock
): CorpusDrift[] {
  const drift: CorpusDrift[] = [];
  const lockedByKey = new Map(locked.cases.map((row) => [row.scenarioKey, row]));
  const freshByKey = new Map(fresh.cases.map((row) => [row.scenarioKey, row]));

  for (const [key, row] of freshByKey) {
    if (!lockedByKey.has(key)) {
      drift.push({ kind: "caseAdded", scenarioKey: key, title: row.title });
    }
  }
  for (const [key, row] of lockedByKey) {
    const current = freshByKey.get(key);
    if (!current) {
      drift.push({ kind: "caseRemoved", scenarioKey: key, title: row.title });
      continue;
    }
    if (current.scenarioContentHash !== row.scenarioContentHash) {
      drift.push({
        kind: "contentChanged",
        scenarioKey: key,
        title: current.title,
      });
    }
    if (current.evaluationConfigHash !== row.evaluationConfigHash) {
      drift.push({
        kind: "evaluationConfigChanged",
        scenarioKey: key,
        title: current.title,
      });
    }
  }
  const compare = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  return drift.sort(
    (left, right) =>
      compare(left.scenarioKey, right.scenarioKey) ||
      compare(left.kind, right.kind)
  );
}

/**
 * Rebuild a corpus from a lock file — no network.
 *
 * Equivalent to the online path by construction: it re-runs the SAME
 * materialization over the stored wire cases. That is what makes the lock a
 * reproducibility record rather than a checksum.
 */
export function loadCorpusFromLock(
  lock: CorpusLock,
  options: { unsupported?: "error" | "skip" } = {}
): LoadedCorpus {
  return buildCorpus({
    ...(lock.project !== undefined ? { project: lock.project } : {}),
    suite: lock.suite,
    cases: lock.cases.map((row) => row.normalizedContent),
    // Replayed, not defaulted — see the field docs on CorpusLock.
    ...(lock.suiteChecks ? { suiteChecks: lock.suiteChecks } : {}),
    ...(lock.suiteMatchOptions
      ? { suiteMatchOptions: lock.suiteMatchOptions }
      : {}),
    ...(options.unsupported ? { unsupported: options.unsupported } : {}),
    fetchedAt: lock.fetchedAt,
  });
}
