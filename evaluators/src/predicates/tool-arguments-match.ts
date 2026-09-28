/**
 * `toolArgumentsMatch` — what went INTO a tool call, checked with patterns.
 *
 * `toolCalledWith` compares argument values exactly, `argumentsMatchToolSchema`
 * only checks they are valid, and `toolResultContains` reads the tool's
 * output. None of them can say "the diagram the model drew mentions Idea,
 * Build and Ship". This kind can, and it says it about ONE call: a call
 * matches only when EVERY pattern matches that same call's arguments, so three
 * labels split across three diagrams never add up to a pass.
 *
 * ── Why re2js and not `RegExp` ──────────────────────────────────────────────
 *
 * Evaluation runs synchronously inside the shared inspector server process —
 * the live verdict, the step executor, swarm checks, and the backtest that
 * replays up to 25 draft rules over every stored iteration. One catastrophic
 * pattern on a backtracking engine stalls every tenant on that replica, and
 * the nested-quantifier heuristic `responseMatches` relies on does not catch
 * `(a|a)*$` or `.*.*.*=`. re2js is linear-time, so there is no pattern to
 * refuse: the price is no lookaround and no backreferences, and `patterns`
 * covers the common reason people reach for lookahead ("contains A and B").
 *
 * A pattern is valid iff `RE2JS.compile(RE2JS.translateRegExp(p), flagBits)`
 * succeeds. The backend's write-time validator runs the same check against the
 * same pinned version, and the shared parity fixtures prove the two agree.
 *
 * ── Why a bounded encoding ──────────────────────────────────────────────────
 *
 * The subject is canonical JSON of the arguments (sorted keys, no whitespace),
 * so `{"a":1,"b":2}` and `{"b":2,"a":1}` read the same. Serialising an
 * unbounded model-authored value is its own cost before any pattern runs, so
 * the subject is written with {@link canonicalJsonBounded}, which stops at
 * {@link MAX_TOOL_ARGUMENT_SUBJECT_CHARS}. A subject that does not fit is
 * UNREADABLE — never truncated, because matching a prefix would grade text the
 * call never sent.
 */

import { RE2JS } from "re2js";
import { canonicalJsonBounded } from "../contract/canonical.js";

/** At most this many patterns per check. Mirrored by the backend validator. */
export const MAX_TOOL_ARGUMENT_PATTERNS = 8;
/** At most this many characters per pattern. Mirrored by the backend. */
export const MAX_TOOL_ARGUMENT_PATTERN_CHARS = 512;
/** At most this many characters in the `argument` key name. */
export const MAX_TOOL_ARGUMENT_NAME_CHARS = 256;
/**
 * The largest subject a call is matched against, in UTF-16 code units. Above
 * it the call is unreadable rather than matched or not.
 */
export const MAX_TOOL_ARGUMENT_SUBJECT_CHARS = 100_000;
/** Displayed pattern text is cut here, in reasons only. */
export const MAX_DISPLAYED_PATTERN_CHARS = 120;

/**
 * The closed flag spellings. One canonical order per set, so `"mi"` and
 * `"im"` cannot both exist as two ids for one check; `g`, `u`, `y` and `d`
 * mean nothing to a test that asks "does it match".
 */
export const TOOL_ARGUMENT_PATTERN_FLAGS = [
  "i",
  "m",
  "s",
  "im",
  "is",
  "ms",
  "ims",
] as const;
export type ToolArgumentPatternFlags =
  (typeof TOOL_ARGUMENT_PATTERN_FLAGS)[number];

/**
 * What the check does, for the scorer's `implementationHash`.
 *
 * The authored rule alone does not pin the verdict: the same patterns over a
 * different engine, encoding or budget can grade the same call differently.
 * Bump `implementationVersion` when any of these change.
 */
export const TOOL_ARGUMENTS_MATCH_IMPLEMENTATION = {
  implementationVersion: 1,
  engine: "re2js",
  encoding: "canonical-json-bounded",
  maxSubjectChars: MAX_TOOL_ARGUMENT_SUBJECT_CHARS,
} as const;

/** The authored fields this module reads. */
export type ToolArgumentsMatchRule = {
  toolName: string;
  patterns: string[];
  flags?: ToolArgumentPatternFlags;
  argument?: string;
  min?: number;
  max?: number;
};

/** The one thing a compiled pattern is asked. */
export type CompiledToolArgumentPattern = { test(subject: string): boolean };

/** re2js flag bits for an authored flag string. */
export function toolArgumentFlagBits(flags: string | undefined): number {
  let bits = 0;
  if (flags?.includes("i")) bits |= RE2JS.CASE_INSENSITIVE;
  if (flags?.includes("m")) bits |= RE2JS.MULTILINE;
  if (flags?.includes("s")) bits |= RE2JS.DOTALL;
  return bits;
}

/** True when `flags` is one of the closed spellings (or absent). */
export function isToolArgumentPatternFlags(
  flags: unknown
): flags is ToolArgumentPatternFlags | undefined {
  return (
    flags === undefined ||
    (TOOL_ARGUMENT_PATTERN_FLAGS as readonly unknown[]).includes(flags)
  );
}

/**
 * Compile one pattern, or say why it does not compile.
 *
 * THE validity rule. Nothing else — not `new RegExp` — decides whether a
 * pattern is acceptable, because a pattern JavaScript accepts and re2js
 * refuses (a lookahead, a backreference) would pass validation and then fail
 * every iteration.
 */
export function compileToolArgumentPattern(
  pattern: string,
  flags: string | undefined
):
  | { ok: true; compiled: CompiledToolArgumentPattern }
  | { ok: false; message: string } {
  try {
    const compiled = RE2JS.compile(
      RE2JS.translateRegExp(pattern),
      toolArgumentFlagBits(flags)
    );
    return { ok: true, compiled };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The compile error for `pattern`, or `undefined` when it compiles. */
export function toolArgumentPatternError(
  pattern: string,
  flags: string | undefined
): string | undefined {
  const result = compileToolArgumentPattern(pattern, flags);
  return result.ok ? undefined : result.message;
}

/**
 * Compile every pattern with the ONE shared flag set, or name the first that
 * does not compile. Authored order is kept: it is part of the criterion id.
 */
export function compilePatterns(
  patterns: readonly string[],
  flags: string | undefined
):
  | { ok: true; compiled: CompiledToolArgumentPattern[] }
  | { ok: false; index: number; message: string } {
  const compiled: CompiledToolArgumentPattern[] = [];
  for (let index = 0; index < patterns.length; index += 1) {
    const result = compileToolArgumentPattern(patterns[index]!, flags);
    if (!result.ok) return { ok: false, index, message: result.message };
    compiled.push(result.compiled);
  }
  return { ok: true, compiled };
}

/**
 * Why a `min`/`max` pair is not a valid count, or `undefined`.
 *
 * `max` must be at least the effective `min` (`min ?? 1`), and `min: 0` needs
 * a `max`: with no ceiling it asserts nothing at all — every transcript has at
 * least zero matching calls. `min: 0, max: 0` is the "no call matches" claim.
 */
export function toolArgumentsMatchBoundsError(
  min: number | undefined,
  max: number | undefined
): { path: "min" | "max"; message: string } | undefined {
  if (min === 0 && max === undefined) {
    return {
      path: "min",
      message:
        "min: 0 needs a max; on its own it passes every transcript " +
        '(use max: 0 for "no call matches")',
    };
  }
  if (max !== undefined && max < (min ?? 1)) {
    return {
      path: "max",
      message: `max must be at least min (${min ?? 1}${
        min === undefined ? ", the default" : ""
      })`,
    };
  }
  return undefined;
}

/**
 * Every reason a rule reaching the evaluator cannot be graded, or `undefined`.
 *
 * The schema refuses all of these at the write boundary. This exists for a
 * rule that arrived by another path (a loosely-typed API payload, a stored row
 * from a newer writer) so the evaluator never grades a check nobody could
 * have validly written.
 */
export function toolArgumentsMatchConfigError(
  rule: Partial<Record<keyof ToolArgumentsMatchRule, unknown>>
): string | undefined {
  if (typeof rule.toolName !== "string" || rule.toolName.length === 0) {
    return "toolArgumentsMatch requires a non-empty toolName";
  }
  const patterns = rule.patterns;
  if (
    !Array.isArray(patterns) ||
    patterns.length < 1 ||
    patterns.length > MAX_TOOL_ARGUMENT_PATTERNS
  ) {
    return `toolArgumentsMatch requires 1 to ${MAX_TOOL_ARGUMENT_PATTERNS} patterns`;
  }
  for (const pattern of patterns) {
    if (
      typeof pattern !== "string" ||
      pattern.length < 1 ||
      pattern.length > MAX_TOOL_ARGUMENT_PATTERN_CHARS
    ) {
      return (
        "every toolArgumentsMatch pattern must be 1 to " +
        `${MAX_TOOL_ARGUMENT_PATTERN_CHARS} characters`
      );
    }
  }
  if (!isToolArgumentPatternFlags(rule.flags)) {
    return `toolArgumentsMatch flags must be one of ${TOOL_ARGUMENT_PATTERN_FLAGS.join(
      ", "
    )}`;
  }
  if (
    rule.argument !== undefined &&
    (typeof rule.argument !== "string" ||
      rule.argument.length < 1 ||
      rule.argument.length > MAX_TOOL_ARGUMENT_NAME_CHARS)
  ) {
    return (
      "toolArgumentsMatch argument must be 1 to " +
      `${MAX_TOOL_ARGUMENT_NAME_CHARS} characters`
    );
  }
  for (const key of ["min", "max"] as const) {
    const count = rule[key];
    if (
      count !== undefined &&
      (typeof count !== "number" || !Number.isInteger(count) || count < 0)
    ) {
      return `toolArgumentsMatch ${key} must be a non-negative integer`;
    }
  }
  const bounds = toolArgumentsMatchBoundsError(
    rule.min as number | undefined,
    rule.max as number | undefined
  );
  return bounds?.message;
}

/**
 * The text one call is matched against.
 *
 *   - `subject` — the text, ready to match.
 *   - `missing` — `argument` is set and this call does not carry it. Not a
 *     match, and not unreadable either: the call demonstrably lacks it.
 *   - `unreadable` — over the budget, or not canonicalizable. The verdict may
 *     not rest on it in either direction.
 *
 * With `argument` set, a STRING value is matched as it is (length-checked
 * before anything else) and anything else as bounded canonical JSON. Without
 * it the whole arguments object is the subject.
 */
export type ToolCallSubject =
  | { kind: "subject"; text: string }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: "overBudget" | "uncanonical" };

export function encodeCallSubject(
  args: unknown,
  argument: string | undefined,
  maxChars: number = MAX_TOOL_ARGUMENT_SUBJECT_CHARS
): ToolCallSubject {
  let value: unknown = args ?? {};
  if (argument !== undefined) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.prototype.hasOwnProperty.call(value, argument)
    ) {
      return { kind: "missing" };
    }
    value = (value as Record<string, unknown>)[argument];
    // Canonical JSON drops an `undefined` property, so the key is absent in
    // every form the call could be read back in.
    if (value === undefined) return { kind: "missing" };
    if (typeof value === "string") {
      return value.length > maxChars
        ? { kind: "unreadable", reason: "overBudget" }
        : { kind: "subject", text: value };
    }
  }
  const encoded = canonicalJsonBounded(value, maxChars);
  return encoded.ok
    ? { kind: "subject", text: encoded.json }
    : { kind: "unreadable", reason: encoded.reason };
}

/** How the calls to the tool fell out. */
export type ToolArgumentsMatchTally = {
  /** Calls to `toolName`. */
  calls: number;
  /** Calls whose subject matched EVERY pattern. */
  matched: number;
  /** Calls whose subject could not be read. */
  unreadable: number;
  /** Calls that did not carry `argument`. Always 0 when it is unset. */
  missingArgument: number;
};

export type ToolArgumentsMatchVerdict = "pass" | "fail" | "unscored";

/**
 * The verdict, with `m` matching and `u` unreadable calls:
 *
 *   - pass  iff `m ≥ min` and `m + u ≤ max`
 *   - fail  iff `m + u < min` or `m > max`
 *   - otherwise unscored — only reachable when the unreadable calls could
 *     have decided it either way.
 *
 * `min` and `max` count MATCHING calls, never all calls.
 */
export function toolArgumentsMatchVerdict(
  tally: Pick<ToolArgumentsMatchTally, "matched" | "unreadable">,
  bounds: { min: number; max: number | undefined }
): ToolArgumentsMatchVerdict {
  const { matched, unreadable } = tally;
  const max = bounds.max ?? Number.POSITIVE_INFINITY;
  if (matched >= bounds.min && matched + unreadable <= max) return "pass";
  if (matched + unreadable < bounds.min || matched > max) return "fail";
  return "unscored";
}

/** `"1 call"` / `"3 calls"`. */
function callCount(count: number): string {
  return `${count} call${count === 1 ? "" : "s"}`;
}

/**
 * The expectation, counting-exact: it always says "matching", because a
 * reader who took `max: 0` to mean "never called" would read a pass on a
 * transcript full of calls as a contradiction.
 */
export function describeExpectation(bounds: {
  min: number;
  max: number | undefined;
}): string {
  const { min, max } = bounds;
  if (max === undefined) return `at least ${min} matching call(s)`;
  if (max === 0) return "no matching call";
  if (min === max) return `exactly ${min} matching call(s)`;
  if (min === 0) return `at most ${max} matching call(s)`;
  return `${min} to ${max} matching calls`;
}

/**
 * The reason sentence. Counts first, so the reason cap cuts the display text
 * and never the numbers. It names which of the three failures happened —
 * never called, called but nothing matched, or too many matched — and always
 * says that the bounds count MATCHING calls.
 *
 * `patternsShown` and `samplesShown` arrive already redacted and capped — the
 * caller owns redaction, because it owns the free-text scrubber and the
 * key-aware `brief()`. Nothing here interpolates a live value.
 */
export function describeMatch(input: {
  toolName: string;
  argument: string | undefined;
  patternCount: number;
  tally: ToolArgumentsMatchTally;
  bounds: { min: number; max: number | undefined };
  verdict: ToolArgumentsMatchVerdict;
  /** e.g. `/Idea/i, /Build/i`, redacted and capped. */
  patternsShown: string;
  /** e.g. `[{"elements":"…"}]`, redacted and capped; omitted on a pass. */
  samplesShown?: string;
}): string {
  const { toolName, argument, patternCount, tally, bounds, verdict } = input;
  const all =
    patternCount === 1 ? "the pattern" : `all ${patternCount} patterns`;
  const where =
    argument === undefined ? "its arguments" : `its "${argument}" argument`;
  const expected =
    `expected ${describeExpectation(bounds)} ` +
    "(min/max count matching calls, not all calls)";
  const detail = `Patterns: ${input.patternsShown}`;
  const got = input.samplesShown ? `. Got: ${input.samplesShown}` : "";
  const missing =
    argument !== undefined && tally.missingArgument > 0
      ? `, ${callCount(tally.missingArgument)} had no "${argument}" argument`
      : "";
  const unreadable =
    tally.unreadable > 0
      ? `, ${tally.unreadable} could not be read (over ` +
        `${MAX_TOOL_ARGUMENT_SUBJECT_CHARS} characters or not serializable)`
      : "";

  if (tally.calls === 0) {
    // Only a pass when the check allows zero matching calls. The reason still
    // says the tool was not called, so nobody reads a `0/0` pass as a finding
    // about calls that happened.
    return verdict === "pass"
      ? `"${toolName}" was not called, so no call matched; ${expected}. ${detail}`
      : `"${toolName}" was never called; ${expected}. ${detail}`;
  }

  const matched =
    tally.matched === 0
      ? `none matched ${all} in ${where}`
      : `${tally.matched} matched ${all} in ${where}`;
  const tooMany =
    verdict === "fail" && bounds.max !== undefined && tally.matched > bounds.max
      ? `, allowed at most ${bounds.max}`
      : "";
  const head =
    `"${toolName}" called ${tally.calls}×, ${matched}${tooMany}` +
    `${missing}${unreadable}`;

  if (verdict === "pass") return `${head}; ${expected}. ${detail}`;
  if (verdict === "unscored") {
    return (
      `${head}; ${expected}, and the unreadable call(s) could decide it ` +
      `either way. ${detail}`
    );
  }
  return `${head}; ${expected}. ${detail}${got}`;
}
