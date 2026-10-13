/**
 * The pattern engine shared by `toolInputMatches` and `toolResultMatches`.
 *
 * Both kinds ask one question of one UNIT at a time — a call's input, or one
 * tool result — and count the units that answer yes:
 *
 *   - a unit MATCHES when EVERY pattern matches that same unit's subject, so
 *     three labels split across three diagrams never add up to a match;
 *   - `min` and `max` count MATCHING units, never all units.
 *
 * `toolCalledWith` compares argument values exactly, `argumentsMatchToolSchema`
 * only checks they are valid, and `toolResultContains` looks for one literal.
 * None of them can say "the diagram the model drew mentions Idea, Build and
 * Ship". These two can.
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
 * JSON is matched as canonical JSON (sorted keys, no whitespace), so
 * `{"a":1,"b":2}` and `{"b":2,"a":1}` read the same. Serialising an unbounded
 * model- or server-authored value is its own cost before any pattern runs, so
 * the subject is written with {@link canonicalJsonBounded}, which stops at
 * {@link MAX_MATCH_SUBJECT_CHARS}. A subject that does not fit is UNREADABLE —
 * never truncated, because matching a prefix would grade text the unit never
 * carried.
 *
 * ── `path` ──────────────────────────────────────────────────────────────────
 *
 * An RFC 6901 JSON Pointer, restricted for now to exactly ONE reference token
 * (`"/elements"`): one top-level key, with `~1` and `~0` decoding to `/` and
 * `~`. The syntax is already the general one, so a later release can accept
 * more tokens and array indexes without a new field. The root pointer `""`
 * is refused — omit `path` to match the whole value — and so is `"/"`, the
 * empty-string key: the whole value is 2–257 characters, and no tool
 * argument or result field worth pinning is named `""`.
 */

import { RE2JS } from "re2js";
import { canonicalJsonBounded } from "../contract/canonical.js";
import type { TranscriptToolResult } from "./types.js";

/** At most this many patterns per check. Mirrored by the backend validator. */
export const MAX_MATCH_PATTERNS = 8;
/** At most this many characters per pattern. Mirrored by the backend. */
export const MAX_MATCH_PATTERN_CHARS = 512;
/** Fewest characters in a `path`: `/` plus a key of at least one character. */
export const MIN_MATCH_PATH_CHARS = 2;
/** Most characters in a `path`, escapes included: `/` plus 256. */
export const MAX_MATCH_PATH_CHARS = 257;
/**
 * A one-token JSON Pointer: a leading `/`, then at least one character with no
 * further unescaped `/`, where every `~` is followed by `0` or `1`. Mirrored
 * by the backend validator and published as the suite-file schema's pattern.
 */
export const MATCH_PATH_PATTERN = /^\/(?:[^/~]|~[01])+$/;
/**
 * The largest subject a unit is matched against, in UTF-16 code units. Above
 * it the unit is unreadable rather than matched or not.
 */
export const MAX_MATCH_SUBJECT_CHARS = 100_000;
/** Displayed pattern text is cut here, in reasons only. */
export const MAX_DISPLAYED_PATTERN_CHARS = 120;

/**
 * The closed flag spellings. One canonical order per set, so `"mi"` and
 * `"im"` cannot both exist as two ids for one check; `g`, `u`, `y` and `d`
 * mean nothing to a test that asks "does it match".
 */
export const MATCH_PATTERN_FLAGS = [
  "i",
  "m",
  "s",
  "im",
  "is",
  "ms",
  "ims",
] as const;
export type MatchPatternFlags = (typeof MATCH_PATTERN_FLAGS)[number];

/** What one kind counts: calls to a tool, or tool results. */
export type MatchUnit = "call" | "result";

/** The two kinds this engine grades. */
export type PatternMatchKind = "toolInputMatches" | "toolResultMatches";

/**
 * What `toolInputMatches` does, for the scorer's `implementationHash`.
 *
 * The authored rule alone does not pin the verdict: the same patterns over a
 * different engine, encoding or budget can grade the same call differently.
 * Bump `implementationVersion` when any of these change.
 */
export const TOOL_INPUT_MATCHES_IMPLEMENTATION = {
  implementationVersion: 1,
  engine: "re2js",
  encoding: "canonical-json-bounded",
  maxSubjectChars: MAX_MATCH_SUBJECT_CHARS,
} as const;

/**
 * What `toolResultMatches` does, for the scorer's `implementationHash`. Its
 * own marker, so either kind can change without re-keying the other.
 *
 * Beyond the engine and budget, a result's verdict also rests on WHICH parts
 * make up its subject and where a `path` is looked up, so both are named.
 */
export const TOOL_RESULT_MATCHES_IMPLEMENTATION = {
  implementationVersion: 1,
  engine: "re2js",
  encoding: "canonical-json-bounded",
  maxSubjectChars: MAX_MATCH_SUBJECT_CHARS,
  subject: "text,structuredContent,json",
  pathSource: "structuredContent,json",
} as const;

/** The authored fields this module reads. */
export type PatternMatchRule = {
  toolName?: string;
  patterns: string[];
  flags?: MatchPatternFlags;
  path?: string;
  min?: number;
  max?: number;
};

/** The one thing a compiled pattern is asked. */
export type CompiledMatchPattern = { test(subject: string): boolean };

/** re2js flag bits for an authored flag string. */
export function matchFlagBits(flags: string | undefined): number {
  let bits = 0;
  if (flags?.includes("i")) bits |= RE2JS.CASE_INSENSITIVE;
  if (flags?.includes("m")) bits |= RE2JS.MULTILINE;
  if (flags?.includes("s")) bits |= RE2JS.DOTALL;
  return bits;
}

/** True when `flags` is one of the closed spellings (or absent). */
export function isMatchPatternFlags(
  flags: unknown
): flags is MatchPatternFlags | undefined {
  return (
    flags === undefined ||
    (MATCH_PATTERN_FLAGS as readonly unknown[]).includes(flags)
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
export function compileMatchPattern(
  pattern: string,
  flags: string | undefined
):
  | { ok: true; compiled: CompiledMatchPattern }
  | { ok: false; message: string } {
  try {
    const compiled = RE2JS.compile(
      RE2JS.translateRegExp(pattern),
      matchFlagBits(flags)
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
export function matchPatternError(
  pattern: string,
  flags: string | undefined
): string | undefined {
  const result = compileMatchPattern(pattern, flags);
  return result.ok ? undefined : result.message;
}

/**
 * Compile every pattern with the ONE shared flag set, or name the first that
 * does not compile. Authored order is kept: it is part of the criterion id.
 */
export function compileMatchPatterns(
  patterns: readonly string[],
  flags: string | undefined
):
  | { ok: true; compiled: CompiledMatchPattern[] }
  | { ok: false; index: number; message: string } {
  const compiled: CompiledMatchPattern[] = [];
  for (let index = 0; index < patterns.length; index += 1) {
    const result = compileMatchPattern(patterns[index]!, flags);
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
 * least zero matching units. `min: 0, max: 0` is the "none matches" claim.
 */
export function matchBoundsError(
  min: number | undefined,
  max: number | undefined,
  unit: MatchUnit
): { path: "min" | "max"; message: string } | undefined {
  if (min === 0 && max === undefined) {
    return {
      path: "min",
      message:
        "min: 0 needs a max; on its own it passes every transcript " +
        `(use max: 0 for "no ${unit} matches")`,
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
 * Why `path` is not an acceptable pointer, or `undefined`.
 *
 * Checked in the order an author fixes things: length, the leading `/`, one
 * key only, then the escapes. {@link MATCH_PATH_PATTERN} says the same thing
 * in one expression; this says which part is wrong.
 */
export function matchPathError(path: unknown): string | undefined {
  if (typeof path !== "string") return "path must be a string";
  if (path.length === 0) {
    return 'path "" is the whole value; omit path instead';
  }
  if (
    path.length < MIN_MATCH_PATH_CHARS ||
    path.length > MAX_MATCH_PATH_CHARS
  ) {
    return (
      `path must be ${MIN_MATCH_PATH_CHARS} to ${MAX_MATCH_PATH_CHARS} ` +
      'characters: "/" and the key, e.g. "/elements"'
    );
  }
  if (!path.startsWith("/")) {
    return 'path must be a JSON Pointer that starts with "/", e.g. "/elements"';
  }
  if (path.indexOf("/", 1) !== -1) {
    return (
      "path must name exactly one top-level key; nested paths are not " +
      'supported yet (write a "/" inside a key as ~1)'
    );
  }
  if (!MATCH_PATH_PATTERN.test(path)) {
    return 'path has an invalid escape: "~" must be followed by 0 or 1';
  }
  return undefined;
}

/**
 * The key a valid `path` names, decoded, or why it is not valid.
 *
 * RFC 6901 order: `~1` becomes `/` first, then `~0` becomes `~`, so `~01`
 * reads as the two characters `~1` rather than as `/`.
 */
export function parseMatchPath(
  path: string
): { ok: true; key: string } | { ok: false; message: string } {
  const error = matchPathError(path);
  if (error !== undefined) return { ok: false, message: error };
  return {
    ok: true,
    key: path.slice(1).replace(/~1/g, "/").replace(/~0/g, "~"),
  };
}

/** The one-token pointer for `key`: `"elements"` → `"/elements"`. */
export function matchPathFromKey(key: string): string {
  return `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

/**
 * Every reason a rule reaching the evaluator cannot be graded, or `undefined`.
 *
 * The schema refuses all of these at the write boundary. This exists for a
 * rule that arrived by another path (a loosely-typed API payload, a stored row
 * from a newer writer) so the evaluator never grades a check nobody could
 * have validly written. `toolName` is required for `toolInputMatches` and
 * optional — but never empty — for `toolResultMatches`.
 */
export function matchRuleConfigError(
  kind: PatternMatchKind,
  rule: Partial<Record<keyof PatternMatchRule, unknown>>
): string | undefined {
  const toolNameRequired = kind === "toolInputMatches";
  if (
    (toolNameRequired || rule.toolName !== undefined) &&
    (typeof rule.toolName !== "string" || rule.toolName.length === 0)
  ) {
    return toolNameRequired
      ? `${kind} requires a non-empty toolName`
      : `${kind} toolName, when set, must be non-empty`;
  }
  const patterns = rule.patterns;
  if (
    !Array.isArray(patterns) ||
    patterns.length < 1 ||
    patterns.length > MAX_MATCH_PATTERNS
  ) {
    return `${kind} requires 1 to ${MAX_MATCH_PATTERNS} patterns`;
  }
  for (const pattern of patterns) {
    if (
      typeof pattern !== "string" ||
      pattern.length < 1 ||
      pattern.length > MAX_MATCH_PATTERN_CHARS
    ) {
      return (
        `every ${kind} pattern must be 1 to ` +
        `${MAX_MATCH_PATTERN_CHARS} characters`
      );
    }
  }
  if (!isMatchPatternFlags(rule.flags)) {
    return `${kind} flags must be one of ${MATCH_PATTERN_FLAGS.join(", ")}`;
  }
  if (rule.path !== undefined) {
    const pathError = matchPathError(rule.path);
    if (pathError !== undefined) return `${kind} ${pathError}`;
  }
  for (const key of ["min", "max"] as const) {
    const count = rule[key];
    if (
      count !== undefined &&
      (typeof count !== "number" || !Number.isInteger(count) || count < 0)
    ) {
      return `${kind} ${key} must be a non-negative integer`;
    }
  }
  const bounds = matchBoundsError(
    rule.min as number | undefined,
    rule.max as number | undefined,
    kind === "toolInputMatches" ? "call" : "result"
  );
  return bounds?.message;
}

/**
 * The text one unit is matched against.
 *
 *   - `subject` — the text, ready to match.
 *   - `missing` — `path` is set and this unit does not carry its key. Not a
 *     match, and not unreadable either: the unit demonstrably lacks it.
 *   - `unreadable` — over the budget, not canonicalizable, or (a result
 *     without `path`) its text was truncated for storage. The verdict may not
 *     rest on it in either direction.
 */
export type MatchSubject =
  | { kind: "subject"; text: string }
  | { kind: "missing" }
  | {
      kind: "unreadable";
      reason: "overBudget" | "uncanonical" | "truncated";
    };

/** Any value as bounded canonical JSON — a string too, quoted. */
function encodeJson(value: unknown, maxChars: number): MatchSubject {
  const encoded = canonicalJsonBounded(value, maxChars);
  return encoded.ok
    ? { kind: "subject", text: encoded.json }
    : { kind: "unreadable", reason: encoded.reason };
}

/**
 * One value a `path` selected, as a subject: a STRING as it is
 * (length-checked before anything else), anything else as bounded canonical
 * JSON.
 */
export function encodeMatchValue(
  value: unknown,
  maxChars: number = MAX_MATCH_SUBJECT_CHARS
): MatchSubject {
  if (typeof value === "string") {
    return value.length > maxChars
      ? { kind: "unreadable", reason: "overBudget" }
      : { kind: "subject", text: value };
  }
  return encodeJson(value, maxChars);
}

/**
 * `container[key]`, or `undefined` when the container is not a plain object
 * or does not carry `key` as its OWN property.
 *
 * Own properties only, so `"/constructor"` never reads the prototype. An
 * array is not a keyed container here: array indexes arrive with multi-token
 * pointers in a later release, and reading `"/0"` as an index today would
 * change the verdict of a stored rule when that release lands.
 */
function ownValue(container: unknown, key: string): unknown {
  if (
    !container ||
    typeof container !== "object" ||
    Array.isArray(container) ||
    !Object.prototype.hasOwnProperty.call(container, key)
  ) {
    return undefined;
  }
  // Canonical JSON drops an `undefined` property, so the key is absent in
  // every form the unit could be read back in.
  return (container as Record<string, unknown>)[key];
}

/**
 * A CALL's subject: the whole arguments object as bounded canonical JSON, or,
 * with `key` (the decoded `path`), only that argument's value.
 */
export function encodeCallSubject(
  args: unknown,
  key: string | undefined,
  maxChars: number = MAX_MATCH_SUBJECT_CHARS
): MatchSubject {
  const value: unknown = args ?? {};
  if (key === undefined) return encodeJson(value, maxChars);
  const at = ownValue(value, key);
  return at === undefined
    ? { kind: "missing" }
    : encodeMatchValue(at, maxChars);
}

/**
 * The value a `path` key selects from a result: the key in
 * `structuredContent`, or in `json` only when there is no
 * `structuredContent` at all. `undefined` when the key is absent.
 */
export function resultValueAt(
  result: Pick<TranscriptToolResult, "structuredContent" | "json">,
  key: string
): unknown {
  return ownValue(
    result.structuredContent !== undefined
      ? result.structuredContent
      : result.json,
    key
  );
}

/**
 * A RESULT's subject.
 *
 * Without `key`: the content `toolResultContains` searches, in its order —
 * the text, then `structuredContent`, then the `json` output part — joined by
 * newlines. Each JSON part is bounded canonical JSON rather than
 * `JSON.stringify`, so key order never decides a match, and the WHOLE
 * subject, separators included, stays within `maxChars`. A result whose text
 * was truncated for storage is unreadable: the part we dropped may be exactly
 * what a pattern needed, and `$` would anchor on our cut instead of the
 * server's end.
 *
 * With `key`: the value under that key in `structuredContent`, falling back
 * to `json` only when there is no `structuredContent` at all. `truncated`
 * does not apply here — it marks the stored TEXT, the one part the
 * transcript caps, and a `path` never reads text.
 */
export function encodeResultSubject(
  result: Pick<
    TranscriptToolResult,
    "text" | "truncated" | "structuredContent" | "json"
  >,
  key: string | undefined,
  maxChars: number = MAX_MATCH_SUBJECT_CHARS
): MatchSubject {
  if (key !== undefined) {
    const at = resultValueAt(result, key);
    return at === undefined
      ? { kind: "missing" }
      : encodeMatchValue(at, maxChars);
  }
  if (result.truncated === true) {
    return { kind: "unreadable", reason: "truncated" };
  }
  const parts: string[] = [];
  let used = 0;
  // Appends one part within what is left of the budget, or returns why it
  // could not. Every part after the first also pays for its newline.
  const append = (
    encode: (budget: number) => MatchSubject
  ): MatchSubject | undefined => {
    const separator = parts.length === 0 ? 0 : 1;
    const budget = maxChars - used - separator;
    if (budget < 0) return { kind: "unreadable", reason: "overBudget" };
    const part = encode(budget);
    if (part.kind !== "subject") return part;
    parts.push(part.text);
    used += separator + part.text.length;
    return undefined;
  };
  const text = result.text;
  if (typeof text === "string") {
    const refused = append((budget) => encodeMatchValue(text, budget));
    if (refused) return refused;
  }
  for (const payload of [result.structuredContent, result.json]) {
    if (payload === undefined) continue;
    const refused = append((budget) => encodeJson(payload, budget));
    if (refused) return refused;
  }
  return { kind: "subject", text: parts.join("\n") };
}

/** How the units in scope fell out. */
export type MatchTally = {
  /** Units read: calls to the tool, or results in scope. */
  units: number;
  /** Units whose subject matched EVERY pattern. */
  matched: number;
  /** Units whose subject could not be read. */
  unreadable: number;
  /** Units that did not carry the `path` key. Always 0 when it is unset. */
  missing: number;
};

export type MatchVerdict = "pass" | "fail" | "unscored";

/**
 * The verdict, with `m` matching and `u` unreadable units:
 *
 *   - pass  iff `m ≥ min` and `m + u + unseen ≤ max`
 *   - fail  iff `m + u + unseen < min` or `m > max`
 *   - otherwise unscored — only reachable when units we could not read, or
 *     never saw, could have decided it either way.
 *
 * `unseen` is how many more units may exist that were never read at all:
 * `0` for a complete scope, `Infinity` when the evidence channel is not
 * complete. With `Infinity`, a pass still needs only proof — `m ≥ min` with
 * no `max` — and a fail only a proven excess (`m > max`); every other
 * outcome would be a claim about units nobody read.
 *
 * `min` and `max` count MATCHING units, never all units.
 */
export function matchVerdict(
  tally: Pick<MatchTally, "matched" | "unreadable">,
  bounds: { min: number; max: number | undefined },
  unseen = 0
): MatchVerdict {
  const { matched } = tally;
  const unknown = tally.unreadable + unseen;
  const max = bounds.max ?? Number.POSITIVE_INFINITY;
  if (matched >= bounds.min && matched + unknown <= max) return "pass";
  if (matched + unknown < bounds.min || matched > max) return "fail";
  return "unscored";
}

/** `"1 call"` / `"3 results"`. */
function countOf(count: number, unit: MatchUnit): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * The expectation, counting-exact: it always says "matching", because a
 * reader who took `max: 0` to mean "never called" would read a pass on a
 * transcript full of calls as a contradiction.
 */
export function describeMatchExpectation(
  bounds: { min: number; max: number | undefined },
  unit: MatchUnit
): string {
  const { min, max } = bounds;
  if (max === undefined) return `at least ${min} matching ${unit}(s)`;
  if (max === 0) return `no matching ${unit}`;
  if (min === max) return `exactly ${min} matching ${unit}(s)`;
  if (min === 0) return `at most ${max} matching ${unit}(s)`;
  return `${min} to ${max} matching ${unit}s`;
}

/** What both reason sentences share. */
type MatchReasonInput = {
  /** The decoded `path` key, or `undefined` when `path` is unset. */
  key: string | undefined;
  patternCount: number;
  tally: MatchTally;
  bounds: { min: number; max: number | undefined };
  verdict: MatchVerdict;
  /** e.g. `/Idea/i, /Build/i`, redacted and capped. */
  patternsShown: string;
  /** e.g. `[{"elements":"…"}]`, redacted and capped; omitted on a pass. */
  samplesShown?: string;
};

function allPatterns(patternCount: number): string {
  return patternCount === 1 ? "the pattern" : `all ${patternCount} patterns`;
}

function expectedClause(
  bounds: MatchReasonInput["bounds"],
  unit: MatchUnit
): string {
  return (
    `expected ${describeMatchExpectation(bounds, unit)} ` +
    `(min/max count matching ${unit}s, not all ${unit}s)`
  );
}

/**
 * `toolInputMatches`' reason sentence. Counts first, so the reason cap cuts
 * the display text and never the numbers. It names which of the three
 * failures happened — never called, called but nothing matched, or too many
 * matched — and always says that the bounds count MATCHING calls.
 *
 * `patternsShown` and `samplesShown` arrive already redacted and capped — the
 * caller owns redaction, because it owns the free-text scrubber and the
 * key-aware `brief()`. Nothing here interpolates a live value.
 */
export function describeInputMatch(
  input: MatchReasonInput & { toolName: string }
): string {
  const { toolName, key, tally, bounds, verdict } = input;
  const all = allPatterns(input.patternCount);
  const where = key === undefined ? "its arguments" : `its "${key}" argument`;
  const expected = expectedClause(bounds, "call");
  const detail = `Patterns: ${input.patternsShown}`;
  const got = input.samplesShown ? `. Got: ${input.samplesShown}` : "";
  const missing =
    key !== undefined && tally.missing > 0
      ? `, ${countOf(tally.missing, "call")} had no "${key}" argument`
      : "";
  const unreadable =
    tally.unreadable > 0
      ? `, ${tally.unreadable} could not be read (over ` +
        `${MAX_MATCH_SUBJECT_CHARS} characters or not serializable)`
      : "";

  if (tally.units === 0) {
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
    `"${toolName}" called ${tally.units}×, ${matched}${tooMany}` +
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

/**
 * `toolResultMatches`' reason sentence, shaped like the input one: counts
 * first, which failure it was — nothing returned, results but none matched,
 * or too many matched — and that the bounds count MATCHING results.
 *
 * `gap` is why results we never read could exist (the capture is incomplete,
 * or observed calls carry no result). It is only ever the reason for an
 * UNSCORED row, and it outranks the unreadable-row explanation: the missing
 * rows are the larger unknown.
 */
export function describeResultMatch(
  input: MatchReasonInput & { toolName: string | undefined; gap?: string }
): string {
  const { toolName, key, tally, bounds, verdict, gap } = input;
  const all = allPatterns(input.patternCount);
  const where = key === undefined ? "their content" : `their "${key}" field`;
  const expected = expectedClause(bounds, "result");
  const detail = `Patterns: ${input.patternsShown}`;
  const got = input.samplesShown ? `. Got: ${input.samplesShown}` : "";
  const missing =
    key !== undefined && tally.missing > 0
      ? `, ${countOf(tally.missing, "result")} had no "${key}" field`
      : "";
  const unreadable =
    tally.unreadable > 0
      ? `, ${tally.unreadable} could not be read (truncated for storage, ` +
        `over ${MAX_MATCH_SUBJECT_CHARS} characters, or not serializable)`
      : "";

  if (tally.units === 0) {
    if (verdict === "unscored") {
      return (
        `${gap ?? "no results were read"}; cannot count matching results; ` +
        `${expected}. ${detail}`
      );
    }
    const none =
      toolName === undefined
        ? "no tool returned a result"
        : `"${toolName}" returned no results`;
    return verdict === "pass"
      ? `${none}, so no result matched; ${expected}. ${detail}`
      : `${none}; ${expected}. ${detail}`;
  }

  const source =
    toolName === undefined
      ? `tools returned ${countOf(tally.units, "result")}`
      : `"${toolName}" returned ${countOf(tally.units, "result")}`;
  const matched =
    tally.matched === 0
      ? `none matched ${all} in ${where}`
      : `${tally.matched} matched ${all} in ${where}`;
  const tooMany =
    verdict === "fail" && bounds.max !== undefined && tally.matched > bounds.max
      ? `, allowed at most ${bounds.max}`
      : "";
  const head = `${source}, ${matched}${tooMany}${missing}${unreadable}`;

  if (verdict === "pass") return `${head}; ${expected}. ${detail}`;
  if (verdict === "unscored") {
    return gap !== undefined
      ? `${head}; ${expected}, but ${gap}; results that were not read could ` +
          `decide it. ${detail}`
      : `${head}; ${expected}, and the unreadable result(s) could decide it ` +
          `either way. ${detail}`;
  }
  return `${head}; ${expected}. ${detail}${got}`;
}
