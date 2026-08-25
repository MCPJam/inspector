/**
 * Project a HOSTED eval suite onto a suite file — or refuse.
 *
 * `eval export` reads a suite the platform owns and writes a file the suite-file
 * contract owns, and the two vocabularies do not line up field for field. Where
 * they do, the mapping is verbatim. Where they do not, this module emits an
 * `UNSUPPORTED_SUITE_EXPORT` finding and the command writes NOTHING.
 *
 * ── Why fail-closed, and why nothing partial ────────────────────────────────
 *
 * A suite file is read back and run. A file that quietly dropped a host
 * attachment, a second model, a judge or a match-option override still parses,
 * still runs, and measures something other than what the dashboard measures —
 * while carrying the dashboard's suite id, so its results join the same
 * history. There is no warning comment that fixes that: a partial file is a
 * wrong file with an apology in it. So an export is all or nothing.
 *
 * ── The exactness proof ─────────────────────────────────────────────────────
 *
 * Two of the shapes the file reuses are deliberately OPEN — a tool call's
 * `arguments` and `predicateSchema` (`sdk/src/contract/suite-file.ts:18-37`) —
 * and an open zod object STRIPS unknown keys instead of rejecting them. So
 * "the candidate validated" is not by itself proof that nothing was lost. The
 * proof is the deep-equality check after it: the validator's OUTPUT must equal
 * the candidate it was given, key for key. Anything zod quietly removed shows
 * up there as a finding naming the path, instead of as a smaller file.
 */

import { isDeepStrictEqual } from "node:util";
import {
  evalSuiteFileSchema,
  isOpaqueId,
  type EvalSuiteFile,
  type EvalSuiteFileCase,
} from "@mcpjam/sdk/contract";
import { suiteFilePointer } from "@mcpjam/sdk";
import type {
  PlatformEvalCase,
  PlatformEvalSuiteDetail,
  PlatformEnvironmentResolved,
  PublicMatchOptions,
} from "@mcpjam/sdk/platform";

/** The one code this module emits. Stable: callers may branch on it. */
export const UNSUPPORTED_SUITE_EXPORT = "UNSUPPORTED_SUITE_EXPORT";

export type SuiteExportFinding = {
  code: typeof UNSUPPORTED_SUITE_EXPORT;
  /**
   * Where the problem is. Paths into the SOURCE suite are named in the
   * platform's vocabulary (`hosts`, `settings.judge`); paths the validator
   * produced are named in the FILE's (`cases[2].steps[0].id`). Which one a
   * finding carries is evident from its message, and mixing them is
   * deliberate: a reader needs to be sent to the thing they can change.
   */
  path: Array<string | number>;
  pointer: string;
  message: string;
};

export type SuiteExportResult =
  | { ok: true; file: EvalSuiteFile }
  | { ok: false; findings: SuiteExportFinding[] };

export type BuildSuiteFileInput = {
  detail: PlatformEvalSuiteDetail;
  cases: PlatformEvalCase[];
  /** Resolved only when the suite has exactly one attached environment. */
  environment?: PlatformEnvironmentResolved;
};

function unsupported(
  path: Array<string | number>,
  message: string
): SuiteExportFinding {
  return {
    code: UNSUPPORTED_SUITE_EXPORT,
    path,
    pointer: suiteFilePointer(path),
    message,
  };
}

/**
 * The suite serialized, but the bytes are over the loader's cap.
 *
 * A refusal, not an internal error: the size is a property of the SUITE — 500
 * cases with long prompts pass every construct check and still do not fit —
 * so it belongs in the same envelope as every other "this suite does not fit
 * the format" answer, rather than surfacing as the round-trip assertion's "this
 * is a bug in the CLI, please report it".
 */
export function suiteFileTooLarge(
  bytes: number,
  limit: number
): SuiteExportFinding {
  return unsupported(
    [],
    `the suite serializes to ${bytes} bytes, over the ${limit}-byte limit a ` +
      `suite file may be. Nothing was written. Split the suite into smaller ` +
      `ones and export each — this never truncates.`
  );
}

// ── percent → fraction ───────────────────────────────────────────────────────

/**
 * Shift a decimal number two places right of the point, in DECIMAL.
 *
 * `85 / 100` is not `0.85` in binary floating point — it is the nearest double,
 * and `(85 / 100) * 100` is `85.00000000000001`. Dividing and then checking the
 * round trip would therefore reject almost every percent a person has ever
 * typed. Shifting the decimal point in the number's own text avoids the
 * question: the result is exactly the value a reader sees, or there is no
 * result at all.
 *
 * Returns `null` for anything that is not plain decimal notation (an exponent
 * form, a non-finite value) rather than converting it approximately.
 */
export function percentToFraction(percent: number): number | null {
  if (!Number.isFinite(percent)) return null;
  // `plainDecimal` on the way IN as well as out: a percent small enough that
  // `toString` reaches for `1e-7` is still an ordinary decimal, and refusing
  // it for its notation would be an arbitrary cliff between two values a
  // hundredth apart.
  const text = plainDecimal(percent);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;

  const [, sign, whole, decimals = ""] = match;
  const digits = `${whole}${decimals}`;
  const pointAt = whole.length - 2;
  const shifted =
    pointAt <= 0
      ? `0.${"0".repeat(-pointAt)}${digits}`
      : `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
  const normalized = `${sign}${shifted}`.replace(/\.?0+$/, "");
  const value = Number(
    normalized === "" || normalized === "-" ? "0" : normalized
  );

  if (!Number.isFinite(value)) return null;
  // `Number.prototype.toString` prints the SHORTEST decimal that round-trips
  // through a double. So this compares the double against the decimal the
  // shift above computed, and holds exactly when no digit was lost turning the
  // percent into a fraction. Comparing `value` against another parse of the
  // same text would compare it with itself and prove nothing.
  return plainDecimal(value) === normalized ? value : null;
}

/**
 * Shift a decimal number two places left of the point, in DECIMAL.
 *
 * The inverse of {@link percentToFraction}: a suite file stores
 * `passThreshold` as a fraction, and the hosted suite grades on a percent.
 * The same discipline applies — refuse rather than approximate — so a
 * threshold that cannot be written as a percent without losing a digit is
 * not uploaded as a nearby value the dashboard would grade differently.
 */
export function fractionToPercent(fraction: number): number | null {
  if (!Number.isFinite(fraction)) return null;
  const text = plainDecimal(fraction);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;

  const [, sign, whole, decimals = ""] = match;
  const digits = `${whole}${decimals}`;
  const newPoint = whole.length + 2;
  const padded = digits.padEnd(newPoint, "0");
  // Always keep a decimal point so the trailing-zero strip only eats the
  // FRACTIONAL side. Without it, a left-shift that lands on an integer
  // (`0.8` → `080`) would have `\.?0+$` turn `80` into `8`.
  const shifted =
    newPoint >= padded.length
      ? `${padded}.0`
      : `${padded.slice(0, newPoint)}.${padded.slice(newPoint)}`;
  const stripped = `${sign}${shifted}`
    .replace(/^(-?)0+(?=\d)/, "$1")
    .replace(/\.?0+$/, "");
  const normalized = stripped === "" || stripped === "-" ? "0" : stripped;
  const value = Number(normalized);

  if (!Number.isFinite(value)) return null;
  if (plainDecimal(value) !== normalized) return null;
  // Close the inverse: this percent must convert back to the same fraction.
  // A left-shift that Number can hold is still refused when it is not the
  // image of {@link percentToFraction} (the dashboard would grade a
  // different threshold).
  return percentToFraction(value) === fraction ? value : null;
}

/**
 * A number's shortest round-tripping decimal, never in exponential notation.
 *
 * `toString` switches to `1e-7` below 1e-6, and the comparison above is against
 * a plain decimal — so without this a threshold of 0.00001% would be refused for
 * its NOTATION rather than for losing a digit. Rewriting the exponent form is
 * exact: the same digits move, nothing is rounded. Only negative exponents are
 * handled because the caller's values are in [0,1].
 */
function plainDecimal(value: number): string {
  const text = value.toString();
  const match = /^(-?)(\d)(?:\.(\d+))?e-(\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, lead, rest = "", exponent] = match;
  return `${sign}0.${"0".repeat(Number(exponent) - 1)}${lead}${rest}`;
}

// ── match options ────────────────────────────────────────────────────────────

/**
 * The match options a suite has when nobody chose any, mirroring
 * `EVAL_MATCH_DEFAULTS` in `sdk/src/matchers.ts` through the public
 * vocabulary. A suite sitting on these grades the way a suite with no match
 * options at all grades, so writing a file without them loses nothing.
 */
const NEUTRAL_MATCH_OPTIONS = {
  toolCallOrder: "any",
  extraToolCalls: "unlimited",
  arguments: "partial",
} as const;

function isNeutralMatchOptions(
  options: PublicMatchOptions | null | undefined
): boolean {
  if (!options) return true;
  const order = options.toolCallOrder ?? NEUTRAL_MATCH_OPTIONS.toolCallOrder;
  const extras = options.extraToolCalls ?? NEUTRAL_MATCH_OPTIONS.extraToolCalls;
  const args = options.arguments ?? NEUTRAL_MATCH_OPTIONS.arguments;
  return (
    order === NEUTRAL_MATCH_OPTIONS.toolCallOrder &&
    extras === NEUTRAL_MATCH_OPTIONS.extraToolCalls &&
    args === NEUTRAL_MATCH_OPTIONS.arguments
  );
}

// ── identity ─────────────────────────────────────────────────────────────────

/**
 * The `id` an exported case carries.
 *
 * Declared identity first, then the platform row id, and NO third branch. The
 * dashboard's own exporter mints one here
 * (`mcpjam-inspector/client/src/lib/evals/eval-export.ts`) and is right to: its
 * normal input already carries the row `_id`, so minting is the rare branch for
 * a draft with no identity yet. A CLI export of a PERSISTED suite always has a
 * row id, so a mint here would not be a fallback — it would be a brand-new
 * identity for a case that already has one, minted afresh on every single
 * export. That is the history fork declared ids exist to prevent, so this
 * refuses instead.
 */
function exportedCaseId(
  evalCase: PlatformEvalCase,
  index: number
): { id: string } | { finding: SuiteExportFinding } {
  const declared = evalCase.declaredId?.trim();
  if (declared && isOpaqueId(declared)) return { id: declared };
  if (isOpaqueId(evalCase.id)) return { id: evalCase.id };
  return {
    finding: unsupported(
      ["cases", index, "id"],
      `case "${evalCase.title}" has neither a declared id nor a platform id ` +
        `that satisfies the opaque-id rule, and this exporter never mints one ` +
        `— a fresh id on every export forks the case's history. Give the case ` +
        `a declared id in the dashboard and export again.`
    ),
  };
}

// ── suite-level constructs with no destination ───────────────────────────────

function suiteLevelFindings(
  detail: PlatformEvalSuiteDetail,
  cases: PlatformEvalCase[],
  environment?: PlatformEnvironmentResolved
): SuiteExportFinding[] {
  const findings: SuiteExportFinding[] = [];
  const settings = detail.settings;

  if (!isOpaqueId(detail.id)) {
    findings.push(
      unsupported(
        ["id"],
        `suite id ${JSON.stringify(detail.id)} is not an opaque id ` +
          `(1-128 of A-Z a-z 0-9 _ -), so it cannot be written to a file`
      )
    );
  }

  const name = detail.name?.trim() ?? "";
  if (name === "") {
    findings.push(
      unsupported(
        ["name"],
        "suite has no name; a suite file requires one. Name the suite in the " +
          "dashboard and export again."
      )
    );
  }

  // ── environment selection ────────────────────────────────────────────────
  const legacyServers = detail.environment?.servers ?? [];
  const environmentIds = detail.environmentIds ?? [];

  if (legacyServers.length > 0 && environmentIds.length > 0) {
    findings.push(
      unsupported(
        ["environmentIds"],
        `suite has both a legacy server selection (${legacyServers.length}) and ` +
          `${environmentIds.length} attached project environment(s). Which one a ` +
          `run uses is a platform decision the file cannot record, and choosing ` +
          `one here would change what runs.`
      )
    );
  } else if (environmentIds.length > 1) {
    findings.push(
      unsupported(
        ["environmentIds"],
        `suite runs against ${environmentIds.length} attached project ` +
          "environments. A suite file can name one environment, and choosing " +
          "one here would change which targets run."
      )
    );
  } else if (environmentIds.length === 1 && !environment) {
    findings.push(
      unsupported(
        ["environmentIds"],
        "suite has one attached project environment, but its name was not resolved"
      )
    );
  } else if (legacyServers.length === 0 && environmentIds.length === 0) {
    findings.push(
      unsupported(
        ["environment"],
        "suite has neither legacy servers nor an attached project environment"
      )
    );
  }

  if (detail.environment?.computerEnvironment) {
    findings.push(
      unsupported(
        ["environment", "computerEnvironment"],
        `suite pins the sandbox image ` +
          `"${
            detail.environment.computerEnvironment.name ??
            detail.environment.computerEnvironment.id
          }", ` +
          `which a suite file has no field for. Dropping it would boot runs from a ` +
          `different image than the dashboard does.`
      )
    );
  }

  // ── execution config ─────────────────────────────────────────────────────
  const execution = detail.executionConfig;
  if (execution === null || execution === undefined) {
    findings.push(
      unsupported(
        ["executionConfig"],
        "suite pins no execution model, and `defaults.model` is required in a " +
          "suite file. There is no way to say 'no default model', and inventing " +
          "one changes what runs. Set the suite's model and export again."
      )
    );
  }

  // ── settings ─────────────────────────────────────────────────────────────
  if (
    settings.minimumAccuracy === null ||
    settings.minimumAccuracy === undefined
  ) {
    findings.push(
      unsupported(
        ["settings", "minimumAccuracy"],
        "suite sets no minimum accuracy, and `defaults.passThreshold` is " +
          "required in a suite file. Set one and export again."
      )
    );
  } else if (
    settings.minimumAccuracy < 0 ||
    settings.minimumAccuracy > 100 ||
    percentToFraction(settings.minimumAccuracy) === null
  ) {
    findings.push(
      unsupported(
        ["settings", "minimumAccuracy"],
        `minimum accuracy ${settings.minimumAccuracy} does not convert to a ` +
          `fraction in [0,1] without losing a digit; a suite file's ` +
          `\`passThreshold\` is a fraction, never a percent`
      )
    );
  }

  const floor = settings.minimumIterations;
  if (typeof floor === "number") {
    // A FLOOR, not a default: every case runs `max(case.iterations, floor)`
    // times. A file that omits it makes each case run its own count, so the
    // floor is lossless exactly when it never binds.
    const raised = cases.filter((entry) => (entry.iterations ?? 0) < floor);
    if (raised.length > 0) {
      findings.push(
        unsupported(
          ["settings", "minimumIterations"],
          `suite floors per-case iterations at ${floor}, raising ${raised.length} ` +
            `case(s) above their own count. A suite file has no floor, so those ` +
            `cases would run fewer times from the file than they do hosted.`
        )
      );
    }
  }

  if (!isNeutralMatchOptions(settings.matchOptions)) {
    findings.push(
      unsupported(
        ["settings", "matchOptions"],
        `suite pins non-default match options ` +
          `(${JSON.stringify(
            settings.matchOptions
          )}), which a suite file has no ` +
          `field for and which no predicate reproduces exactly`
      )
    );
  }

  if (settings.judge?.autoRun === true) {
    findings.push(
      unsupported(
        ["settings", "judge"],
        "suite automatically runs LLM-as-judge grading, and a suite file has " +
          "no judge vocabulary. Exporting it would produce a file that " +
          "grades with deterministic assertions alone."
      )
    );
  }

  return findings;
}

// ── per-case constructs with no destination ──────────────────────────────────

function caseLevelFindings(
  evalCase: PlatformEvalCase,
  index: number,
  suiteChecks: unknown[]
): SuiteExportFinding[] {
  const findings: SuiteExportFinding[] = [];
  // `?? []` on fields the platform types mark required: this is a tolerant
  // reader over a wire shape, and a TypeError surfacing as an internal CLI
  // failure is a worse answer than a finding naming the case.
  const models = evalCase.models ?? [];
  const steps = evalCase.steps ?? [];

  if (models.length > 1) {
    findings.push(
      unsupported(
        ["cases", index, "models"],
        `case "${evalCase.title}" runs against ${models.length} models ` +
          `(${models.map((entry) => entry.model).join(", ")}); a suite ` +
          `file's \`model\` is one id, and a compare-across-models case has no ` +
          `single-model representation`
      )
    );
  }

  if (evalCase.scenario !== undefined && evalCase.scenario !== null) {
    findings.push(
      unsupported(
        ["cases", index, "scenario"],
        `case "${evalCase.title}" is bound to scenario ` +
          `"${evalCase.scenario}", which a suite file has no field for`
      )
    );
  }

  if (!isNeutralMatchOptions(evalCase.matchOptions)) {
    findings.push(
      unsupported(
        ["cases", index, "matchOptions"],
        `case "${evalCase.title}" pins non-default match options ` +
          `(${JSON.stringify(
            evalCase.matchOptions
          )}), which a suite file has no ` +
          `field for and which no predicate reproduces exactly`
      )
    );
  }

  const checks = evalCase.checks;
  // Same tolerant-reader `?? []` as `models`/`steps` above: `list` is typed
  // required beside `mode`, and a backend that skewed and sent only `mode`
  // would otherwise raise a TypeError where a finding belongs.
  const checkList = checks?.list ?? [];
  if (checks && checks.mode !== "inherit") {
    findings.push(
      unsupported(
        ["cases", index, "checks"],
        `case "${evalCase.title}" ${checks.mode}s the suite's checks. A suite ` +
          `file has no inheritance vocabulary: every case carries its own flat ` +
          `\`assertions\`, so there is nothing for a "${checks.mode}" to mean.`
      )
    );
  } else if (checks && checks.mode === "inherit" && checkList.length > 0) {
    // `resolveEffectiveChecks` proves the list is dead in `inherit` mode — the
    // case grades on the suite's checks. Dead or not, it is authored content
    // with nowhere to go, and this command does not decide on an author's
    // behalf which of their checks do not matter.
    findings.push(
      unsupported(
        ["cases", index, "checks", "list"],
        `case "${evalCase.title}" inherits the suite's checks but also carries ` +
          `${checkList.length} of its own. The hosted run ignores them; a file ` +
          `would have to drop them outright, which this refuses to do silently.`
      )
    );
  }

  if (steps.length === 0) {
    findings.push(
      unsupported(
        ["cases", index, "steps"],
        `case "${evalCase.title}" has no steps; a suite-file case requires at ` +
          `least one`
      )
    );
  }

  // Checks are written onto every case, so a suite check the predicate contract
  // does not recognise fails HERE, once per case, with the case named.
  suiteChecks.forEach((check, ordinal) => {
    if (check && typeof check === "object" && !Array.isArray(check)) return;
    findings.push(
      unsupported(
        ["cases", index, "assertions", ordinal],
        `the suite's check at position ${ordinal} is not an object, so it ` +
          `cannot be written as an assertion on case "${evalCase.title}"`
      )
    );
  });

  return findings;
}

// ── repetitions ──────────────────────────────────────────────────────────────

/**
 * Pick `defaults.repetitions`: the count the most cases use, smallest on a tie.
 *
 * The choice is cosmetic — every case whose count differs carries an explicit
 * `repetitions`, so the resolved value is `case.iterations` either way — but it
 * must be DETERMINISTIC, because the alternative is an export whose diff moves
 * every time the case order changes.
 */
export function modalRepetitions(counts: readonly number[]): number {
  if (counts.length === 0) return 1;
  const tally = new Map<number, number>();
  for (const count of counts) {
    tally.set(count, (tally.get(count) ?? 0) + 1);
  }
  let best = counts[0];
  let bestSeen = 0;
  for (const [value, seen] of [...tally.entries()].sort(
    (a, b) => a[0] - b[0]
  )) {
    if (seen > bestSeen) {
      best = value;
      bestSeen = seen;
    }
  }
  return best;
}

// ── provider ─────────────────────────────────────────────────────────────────

type ProviderDecision =
  | { ok: true; provider?: string }
  | { ok: false; finding: SuiteExportFinding };

/**
 * A suite file's `provider` is SUITE-LEVEL only, so it can be written when
 * every case that names one names the same one. Cases that disagree — including
 * one that pins a provider while another leaves it open — have no single
 * suite-level answer, and picking one silently re-routes somebody's model.
 */
function hoistProvider(cases: PlatformEvalCase[]): ProviderDecision {
  const declared = cases
    .map((entry, index) => ({
      index,
      provider: entry.models?.[0]?.provider,
      declares: (entry.models ?? []).length > 0,
    }))
    .filter((row) => row.declares);
  if (declared.length === 0) return { ok: true };

  const distinct = [...new Set(declared.map((row) => row.provider))];
  if (distinct.length <= 1) {
    const [only] = distinct;
    return only === undefined || only === ""
      ? { ok: true }
      : { ok: true, provider: only };
  }

  const disagreeing = declared.find(
    (row) => row.provider !== declared[0].provider
  );
  return {
    ok: false,
    finding: unsupported(
      ["cases", disagreeing?.index ?? 0, "models", 0, "provider"],
      `cases disagree about their model provider ` +
        `(${distinct
          .map((value) => JSON.stringify(value ?? null))
          .join(", ")}), ` +
        `and a suite file carries one suite-level provider`
    ),
  };
}

// ── the deep-equality proof ──────────────────────────────────────────────────

/**
 * Every path at which `actual` differs from `expected`, in document order.
 *
 * Descends so a difference is reported at the field that changed rather than
 * at the whole document. The two `if (out.length === before)` guards keep the
 * function's contract — "unequal implies at least one path" — true even where
 * descending cannot find the difference: a key PRESENT with an `undefined`
 * value on one side and ABSENT on the other is unequal to
 * `isDeepStrictEqual`, but compares `undefined` with `undefined` key-by-key
 * and would otherwise push nothing. This function is the module's exactness
 * proof, and a proof that can silently return "no differences" for a value it
 * was told is different is not one.
 */
function differences(
  expected: unknown,
  actual: unknown,
  path: Array<string | number> = [],
  out: Array<Array<string | number>> = []
): Array<Array<string | number>> {
  if (isDeepStrictEqual(expected, actual)) return out;

  // Against `out.length` AT ENTRY, not against zero: `out` accumulates across
  // the whole traversal, so a sibling's finding would otherwise mask this
  // node's.
  const before = out.length;

  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      differences(expected[index], actual[index], [...path, index], out);
    }
    if (out.length === before) out.push(path);
    return out;
  }

  const bothObjects =
    expected !== null &&
    actual !== null &&
    typeof expected === "object" &&
    typeof actual === "object" &&
    !Array.isArray(expected) &&
    !Array.isArray(actual);
  if (bothObjects) {
    const keys = [
      ...new Set([
        ...Object.keys(expected as object),
        ...Object.keys(actual as object),
      ]),
    ].sort();
    for (const key of keys) {
      differences(
        (expected as Record<string, unknown>)[key],
        (actual as Record<string, unknown>)[key],
        [...path, key],
        out
      );
    }
    if (out.length === before) out.push(path);
    return out;
  }

  out.push(path);
  return out;
}

// ── the adapter ──────────────────────────────────────────────────────────────

/**
 * Build the suite file for a fetched suite, or the reasons it cannot be built.
 *
 * Order of business: every construct with no destination first, then — only if
 * there were none — assemble, validate against the contract, and prove nothing
 * was stripped. Construct findings and validator findings never mix, because a
 * candidate assembled around a missing model or an absent server list would
 * produce validator noise about fields the caller did not get wrong.
 */
export function buildSuiteFileFromPlatform(
  input: BuildSuiteFileInput
): SuiteExportResult {
  const { detail, cases } = input;
  const suiteChecks = detail.settings.checks ?? [];

  const findings = suiteLevelFindings(detail, cases, input.environment);
  cases.forEach((evalCase, index) => {
    findings.push(...caseLevelFindings(evalCase, index, suiteChecks));
  });

  if (cases.length === 0) {
    findings.push(
      unsupported(
        ["cases"],
        "suite has no cases; a suite file requires at least one"
      )
    );
  }

  const provider = hoistProvider(cases);
  const hoistedProvider = provider.ok ? provider.provider : undefined;
  if (!provider.ok) findings.push(provider.finding);

  const caseIds: string[] = [];
  cases.forEach((evalCase, index) => {
    const resolved = exportedCaseId(evalCase, index);
    if ("finding" in resolved) {
      findings.push(resolved.finding);
      return;
    }
    caseIds.push(resolved.id);
  });

  if (findings.length > 0) return { ok: false, findings };

  const repetitions = modalRepetitions(cases.map((entry) => entry.iterations));
  const executionConfig = detail.executionConfig as NonNullable<
    PlatformEvalSuiteDetail["executionConfig"]
  >;
  const suiteModel = executionConfig.model;
  const assertions = suiteChecks as EvalSuiteFileCase["assertions"];

  const candidate = {
    schemaVersion: "1",
    mode: "agentWorkflow",
    reportingMode: "standard",
    suite: {
      // File-owned suites keep the declared id the file authored. A UI suite
      // has none, so export still writes the Convex document id — running that
      // file back is the ownership refusal, not an attach.
      id: detail.declaredId ?? detail.id,
      name: (detail.name ?? "").trim(),
      ...(detail.description === null || detail.description === undefined
        ? {}
        : { description: detail.description }),
    },
    target: {
      ...(detail.environment?.servers?.length
        ? {
            servers: detail.environment.servers.map((name) => ({ name })),
          }
        : {}),
      ...(input.environment
        ? { environment: input.environment.environment.name }
        : {}),
      ...(detail.hosts?.length
        ? {
            hosts: detail.hosts.map((host) => ({
              name: host.name,
              id: host.id,
              ...(host.servers
                ? { servers: host.servers.map((name) => ({ name })) }
                : {}),
            })),
          }
        : {}),
    },
    defaults: {
      model: suiteModel,
      ...(hoistedProvider === undefined ? {} : { provider: hoistedProvider }),
      ...(executionConfig.systemPrompt === undefined
        ? {}
        : { systemPrompt: executionConfig.systemPrompt }),
      ...(executionConfig.temperature === undefined
        ? {}
        : { temperature: executionConfig.temperature }),
      repetitions,
      passThreshold: percentToFraction(
        detail.settings.minimumAccuracy as number
      ) as number,
      // `{}`, not the resolved defaults: the contract documents them and the
      // loader applies them, and writing them here would put values nobody
      // authored into the file (`sdk/src/contract/suite-file.ts:12-17`).
      validity: {},
    },
    // `provenance` and `cases[].import` are NEVER written by export. This is a
    // hosted READ, not a conversion from a foreign format, and claiming an
    // import status for it would assert a faithfulness claim about a mapping
    // that never happened.
    cases: cases.map((evalCase, index) => ({
      id: caseIds[index],
      title: evalCase.title,
      ...(evalCase.iterations === repetitions
        ? {}
        : { repetitions: evalCase.iterations }),
      ...(evalCase.isNegative ? { isNegativeTest: true } : {}),
      ...(evalCase.expectedOutput === undefined ||
      evalCase.expectedOutput === null
        ? {}
        : { expectedOutput: evalCase.expectedOutput }),
      ...(evalCase.models?.[0]?.model === undefined ||
      evalCase.models[0].model === suiteModel
        ? {}
        : { model: evalCase.models[0].model }),
      steps: evalCase.steps,
      ...(assertions && assertions.length > 0 ? { assertions } : {}),
    })),
  };

  const parsed = evalSuiteFileSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      findings: parsed.error.issues.map((issue) =>
        unsupported(
          [...issue.path] as Array<string | number>,
          `the exported suite file would be invalid: ${issue.message}`
        )
      ),
    };
  }

  // The strip check. See the module docblock: two reused shapes are open on
  // purpose, and an open zod object drops unknown keys rather than refusing
  // them, so a suite carrying a step field or a check field this contract does
  // not know would otherwise export SMALLER than it came in.
  const lost = differences(candidate, parsed.data);
  if (lost.length > 0) {
    return {
      ok: false,
      findings: lost.map((path) =>
        unsupported(
          path,
          `the suite file contract does not carry this value, so exporting ` +
            `would drop it. Nothing was written.`
        )
      ),
    };
  }

  return { ok: true, file: parsed.data };
}

/** Where `eval export` writes when the caller names no path. */
export function defaultSuiteFilePath(suiteId: string): string {
  // The suite's stable, path-safe identity — never its display name. A name
  // can hold a slash, and it changes on a rename, which would leave the next
  // export writing a SECOND file for the same suite.
  return `.mcpjam/evals/${suiteId}.yaml`;
}
