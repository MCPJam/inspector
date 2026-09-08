/**
 * Pure evaluator for the state-based predicate library.
 *
 * `evaluatePredicates(transcript, predicates)` returns one
 * {@link PredicateResult} per predicate; `allPredicatesPassed` reduces them to
 * the case verdict (a case passes iff **all** predicates pass; zero predicates
 * pass vacuously). Every function here is a pure function of its inputs — no
 * I/O, no clocks, no randomness — which is exactly what makes predicates a
 * valid CI gate.
 */

import { argMatch } from "./argMatcher.js";
import { checkRole } from "./policy.js";
import { isTurnScopablePredicateKind } from "./types.js";
import { validateAgainstSchema } from "./schema-validation.js";
import { canonicalJson } from "../contract/canonical.js";
import type {
  IterationTranscript,
  Predicate,
  PredicateResult,
  RenderObservationSummary,
  TranscriptCaptureState,
  TranscriptToolCall,
  TranscriptToolCallTiming,
  TranscriptToolInventoryEntry,
  TranscriptToolResult,
} from "./types.js";

// Reason strings are persisted to `testIteration.metadata.predicates`, so any
// value interpolated from the live run (actual tool args, tool error messages)
// is a data-exfiltration and metadata-bloat risk. Every interpolated value goes
// through `brief()` (deep key-redaction + length cap) or `truncate()`, and every
// finished reason is capped by `pass()`/`fail()`.
const MAX_VALUE_CHARS = 200;
const MAX_ERROR_MSG_CHARS = 200;
const MAX_ITEMS_SHOWN = 3;
const MAX_REASON_CHARS = 600;
const REDACTED = "«redacted»";
// Above this length a `responseMatches` predicate fails closed instead of
// evaluating: truncating would silently turn an end-anchored/suffix pattern into
// a misleading non-match, and running an authored regex over a huge string
// risks catastrophic backtracking.
const MAX_REGEX_INPUT_CHARS = 100_000;

// Heuristic ReDoS guard: a quantifier (`+`, `*`, or `}` closing `{m,n}`)
// immediately followed by `)` and another quantifier (`+`, `*`, `{`) is the
// classic "nested quantifier" shape — `(a+)+`, `(.+)*`, `(?:x+){2,}` — that
// makes V8's backtracking engine pin a CPU for seconds-to-minutes on short
// adversarial inputs. The 100k char cap above doesn't help: ReDoS is a
// property of the pattern, not the input. We fail closed on suspicious
// patterns; small false-positive risk on escaped-quantifier patterns like
// `(\+)+` is the right trade vs. hanging the eval runner's event loop.
// Adversarial alternation (`(a|a)+`) still slips through and needs a real
// linear-time engine (RE2) — tracked as follow-up.
const NESTED_QUANTIFIER = /[+*}]\??\)[+*{]/;

/** Keys whose values are scrubbed before a tool-arg blob is rendered. */
const SENSITIVE_KEY =
  /(authorization|bearer|password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|cookie|credential|private[_-]?key)/i;

/** Deep-copy `value`, replacing sensitive-keyed values with a redaction marker. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "«depth-limit»";
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => redact(v, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Cap a string, marking how much was dropped. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

/**
 * Redacted, length-bounded JSON for embedding a value in a reason string. Used
 * for both expected (authored) and actual (live-run) tool args — redaction is
 * defense-in-depth on the authored side and load-bearing on the live side.
 */
function brief(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(redact(value ?? {}));
  } catch {
    json = String(value);
  }
  return truncate(json ?? "null", MAX_VALUE_CHARS);
}

function callsTo(
  transcript: IterationTranscript,
  toolName: string
): TranscriptToolCall[] {
  return (transcript.toolCalls ?? []).filter((c) => c.toolName === toolName);
}

function resolveFinalMessage(transcript: IterationTranscript): string {
  return typeof transcript.finalAssistantMessage === "string"
    ? transcript.finalAssistantMessage
    : "";
}

/**
 * Does the final assistant message end by asking the user something?
 *
 * Reads the LAST NON-EMPTY LINE and asks whether it ends in `?`. Trailing
 * blank lines and a trailing citation block are common enough that testing the
 * raw string's last character would miss real questions; going line-by-line
 * from the end is the cheapest rule that survives both.
 *
 * An empty message is `false` — there is no question in nothing. That keeps
 * this honest as the producer of the run-level `endedWithQuestion` fact, which
 * is written for EVERY trial whether or not anybody authored the check, so the
 * route-facts rate stops being permanently `notMeasured`.
 *
 * It cannot tell an offer from a request for missing input. That is the whole
 * reason `noEndingQuestion` is an observation.
 */
export function finalMessageEndsWithQuestion(
  message: string | undefined | null
): boolean {
  if (typeof message !== "string") return false;
  const lines = message.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (line.length === 0) continue;
    return line.endsWith("?");
  }
  return false;
}

/** The last non-empty line, capped, for a reason string. */
function lastNonEmptyLine(message: string): string {
  const lines = message.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (line.length > 0) return line;
  }
  return "";
}

/**
 * The render observations a `widget*` predicate evaluates over: all of the
 * iteration's observations, narrowed to `toolName` when the predicate sets it.
 * Every `widget*` predicate fails closed on an empty scope — no observations
 * means the check cannot attest, which must not read as a pass.
 */
function renderScope(
  transcript: IterationTranscript,
  toolName: string | undefined
): RenderObservationSummary[] {
  const all = transcript.renderObservations ?? [];
  return toolName === undefined
    ? all
    : all.filter((o) => o.toolName === toolName);
}

/** `"…no render observations recorded for tool \"x\""` / `"…recorded"`. */
function emptyScopeReason(toolName: string | undefined): string {
  return toolName === undefined
    ? "no widget render observations recorded"
    : `no widget render observations recorded for tool "${toolName}"`;
}

/** Distinct non-`rendered` statuses, capped, for failure reasons. */
function describeStatuses(scope: RenderObservationSummary[]): string {
  const statuses = Array.from(new Set(scope.map((o) => o.status)));
  const shown = statuses.slice(0, MAX_ITEMS_SHOWN).join(", ");
  const more =
    statuses.length > MAX_ITEMS_SHOWN
      ? `, +${statuses.length - MAX_ITEMS_SHOWN} more`
      : "";
  return `${shown}${more}`;
}

function resolveTotalTokens(
  transcript: IterationTranscript
): number | undefined {
  const usage = transcript.usage;
  if (!usage) return undefined;
  const { inputTokens, outputTokens, totalTokens } = usage;
  const sum =
    typeof inputTokens === "number" || typeof outputTokens === "number"
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined;
  const total = typeof totalTokens === "number" ? totalTokens : undefined;
  if (total === undefined && sum === undefined) return undefined;
  // Providers sometimes report input/output while leaving totalTokens at 0; take
  // the larger so the budget can't be bypassed by a zero total.
  return Math.max(total ?? 0, sum ?? 0);
}

/**
 * Sanitize an authored predicate for persistence. Reason strings already go
 * through `brief()` (deep key-redaction), but the original `predicate` object
 * is echoed back inside every {@link PredicateResult} and the runner persists
 * those rows to `testIteration.metadata.predicates`. Without this, a
 * `toolCalledWith` predicate whose `args.args` includes a sensitive key
 * (`authorization`, `token`, etc.) round-trips its raw value into Convex.
 *
 * Surgical (not blanket-`redact()`): the deep redactor would also rewrite
 * legitimate scalar fields whose names happen to contain a sensitive substring
 * (e.g. `tokenBudgetUnder.tokens` matches `/token/i`). Only the `toolCalledWith`
 * `args.args` blob carries author-supplied keys/values that can leak; other
 * predicate shapes are either pure scalars (`tokens`, `caseSensitive`),
 * author-chosen literals where redaction would destroy the predicate's meaning
 * (`needle`, `pattern`), or carry no payload at all.
 */
function sanitizePredicate(predicate: Predicate): Predicate {
  if (predicate.type === "toolCalledWith") {
    return {
      ...predicate,
      args: {
        ...predicate.args,
        args: redact(predicate.args.args ?? {}) as Record<string, unknown>,
      },
    };
  }
  return predicate;
}

function pass(predicate: Predicate, reason: string): PredicateResult {
  return {
    predicate: sanitizePredicate(predicate),
    passed: true,
    reason: truncate(reason, MAX_REASON_CHARS),
  };
}

function fail(predicate: Predicate, reason: string): PredicateResult {
  return {
    predicate: sanitizePredicate(predicate),
    passed: false,
    reason: truncate(reason, MAX_REASON_CHARS),
  };
}

/**
 * THE EVIDENCE WAS NOT THERE.
 *
 * Not a verdict in either direction. `passed: false` because the field is
 * required and an unscored check is not a passed one — but `status: "error"`
 * is what every reader keys on: the score row carries no value, the stage
 * stays `notMeasured`, and nothing attributes a defect to the server for a
 * measurement WE could not take.
 *
 * Distinct from a fail-closed row (`tokenBudgetUnder` with no usage), which
 * predates this field and stays a scored failure so no historical verdict
 * moves. New evidence-dependent kinds use this instead: they are about the
 * server's answers, and blaming a server for our own blind spot is exactly
 * the mis-attribution the chain exists to avoid.
 */
function evidenceError(predicate: Predicate, reason: string): PredicateResult {
  return {
    predicate: sanitizePredicate(predicate),
    passed: false,
    status: "error",
    reason: truncate(reason, MAX_REASON_CHARS),
  };
}

/** How completely a channel was captured. Absent capture ⇒ `absent`. */
function captureState(
  transcript: IterationTranscript,
  channel: keyof NonNullable<IterationTranscript["capture"]>
): TranscriptCaptureState {
  return transcript.capture?.[channel] ?? "absent";
}

/** Tool results in scope, narrowed to `toolName` when the predicate sets it. */
function resultScope(
  transcript: IterationTranscript,
  toolName: string | undefined
): TranscriptToolResult[] {
  const all = transcript.toolResults ?? [];
  return toolName === undefined
    ? all
    : all.filter((r) => r.toolName === toolName);
}

/** Timings in scope, narrowed to `toolName` when the predicate sets it. */
function timingScope(
  transcript: IterationTranscript,
  toolName: string | undefined
): TranscriptToolCallTiming[] {
  const all = transcript.toolCallTimings ?? [];
  return toolName === undefined
    ? all
    : all.filter((t) => t.toolName === toolName);
}

/** `"tool \"x\""` / `"any tool"`, for reasons. */
function scopeLabel(toolName: string | undefined): string {
  return toolName === undefined ? "any tool" : `tool "${toolName}"`;
}

/**
 * Model-visible text of a result, flattened for `toolResultContains`.
 *
 * Reads the stored text first, then the structured/JSON payloads — a server
 * that answers only with `structuredContent` still has content the check is
 * about, and requiring text would report it as containing nothing.
 */
function resultText(result: TranscriptToolResult): string {
  const parts: string[] = [];
  if (typeof result.text === "string") parts.push(result.text);
  for (const payload of [result.structuredContent, result.json]) {
    if (payload === undefined) continue;
    try {
      parts.push(JSON.stringify(payload) ?? "");
    } catch {
      // A payload that will not serialize contributes nothing rather than
      // aborting the check.
    }
  }
  return parts.join("\n");
}

/**
 * The payload a schema check validates, most authoritative first.
 *
 * `structuredContent` is the server's own typed answer, so it outranks the
 * JSON output part and both outrank text that merely looks like JSON.
 */
function resultPayload(
  result: TranscriptToolResult
): { found: true; value: unknown } | { found: false } {
  if (result.structuredContent !== undefined) {
    return { found: true, value: result.structuredContent };
  }
  if (result.json !== undefined) return { found: true, value: result.json };
  if (typeof result.text === "string" && result.text.trim().length > 0) {
    try {
      return { found: true, value: JSON.parse(result.text) };
    } catch {
      return { found: false };
    }
  }
  return { found: false };
}

/** Calls in scope, narrowed to `toolName` when the predicate sets it. */
function callScope(
  transcript: IterationTranscript,
  toolName: string | undefined
): TranscriptToolCall[] {
  const all = transcript.toolCalls ?? [];
  return toolName === undefined
    ? all
    : all.filter((c) => c.toolName === toolName);
}

/**
 * What an EMPTY evidence scope means for a check that grades rows.
 *
 * Three readings, and only one of them is a verdict. A channel nobody captured
 * is unmeasured. A channel captured completely whose scope holds no rows AND
 * no calls is a scored absence — nothing ran, so there is nothing to grade.
 * The same empty scope with CALLS in it is unmeasured too: those calls
 * happened and we hold no measurement of them. Reading that third case as
 * "nothing ran" is how a ceiling passes on an iteration nobody measured, and
 * how a content check reports "returned no results" about a result we never
 * extracted.
 */
function emptyScopeIsScored(
  transcript: IterationTranscript,
  channel: "toolResults" | "toolCallTimings",
  toolName: string | undefined
): { scored: true } | { scored: false; reason: string } {
  const label = channel === "toolResults" ? "tool result" : "per-call timing";
  if (captureState(transcript, channel) !== "complete") {
    return {
      scored: false,
      reason: `no ${label}s captured for ${scopeLabel(toolName)}`,
    };
  }
  const calls = callScope(transcript, toolName).length;
  if (calls > 0) {
    return {
      scored: false,
      reason:
        `${calls} observed call(s) to ${scopeLabel(toolName)} ` +
        `carry no ${label}`,
    };
  }
  return { scored: true };
}

/**
 * ` (2 of 5 observed call(s) measured)`, or `""` when coverage is total.
 *
 * A budget graded over fewer rows than there were calls is still a real
 * reading, but the count in the reason must not read as coverage it does not
 * have — an errored call carries no result, and a narrated one no timing.
 */
function coverageNote(measured: number, observed: number): string {
  return observed > measured
    ? ` (${measured} of ${observed} observed call(s) measured)`
    : "";
}

/** The advertised tool, by name, or `undefined` when it was not advertised. */
function inventoryEntry(
  transcript: IterationTranscript,
  toolName: string
): TranscriptToolInventoryEntry | undefined {
  return (transcript.toolInventory ?? []).find((t) => t.name === toolName);
}

/**
 * Canonical form of a call's arguments, for equality.
 *
 * `canonicalJson` rather than `canonicalDigest`: the two answer the same
 * question (are these argument objects the same?) and comparing the canonical
 * STRINGS skips a hash per call while staying key-order- and
 * whitespace-insensitive. A value that will not canonicalize compares as
 * unequal to everything, including itself — an unreadable argument blob is
 * not evidence of a repeat.
 */
function canonicalArgs(call: TranscriptToolCall, index: number): string {
  try {
    return canonicalJson(call.arguments ?? {});
  } catch {
    return `«uncanonical:${index}»`;
  }
}

/**
 * A tool's description marks it deprecated ABOUT ITSELF.
 *
 * Anchored patterns, not "mentions the word": "Replaces the deprecated
 * `old_search` tool" is a CURRENT tool describing its predecessor, and firing
 * on it would be a detector error rather than a debatable finding. Still a
 * heuristic — it reads prose — which is why the kind is Warn/Report only.
 */
const SELF_DEPRECATION = [
  /^\s*\[?\s*deprecated\b/i,
  /\bthis (?:tool|endpoint|method) is deprecated\b/i,
  /\bdeprecated[:.]/i,
  /\buse\s+\S+\s+instead\b/i,
];

function describesItselfAsDeprecated(description: string | undefined): boolean {
  if (typeof description !== "string" || description.length === 0) return false;
  return SELF_DEPRECATION.some((pattern) => pattern.test(description));
}

/**
 * Argument names a server uses for "how many results do you want".
 *
 * A closed list rather than a pattern: a page-size check that guessed from any
 * numeric argument would fire on `timeoutMs` and `retries`.
 */
const PAGE_LIMIT_KEYS = [
  "limit",
  "page_size",
  "pageSize",
  "per_page",
  "perPage",
  "max_results",
  "maxResults",
  "first",
  "top",
];

/** Keys a server uses to say "there is more". Recognized, not exhaustive. */
const CONTINUATION_KEYS = [
  "nextCursor",
  "next_cursor",
  "hasMore",
  "has_more",
  "cursor",
  "nextPage",
  "next_page",
  "nextPageToken",
  "truncated",
];

/** The requested page size on a call, if it asked for one. */
function requestedLimit(call: TranscriptToolCall): number | undefined {
  const args = call.arguments ?? {};
  for (const key of PAGE_LIMIT_KEYS) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

/** The longest top-level array in a payload, as the page it stands for. */
function longestTopLevelArray(payload: unknown): number | undefined {
  if (Array.isArray(payload)) return payload.length;
  if (!payload || typeof payload !== "object") return undefined;
  let longest: number | undefined;
  for (const value of Object.values(payload as Record<string, unknown>)) {
    if (Array.isArray(value) && (longest === undefined || value.length > longest)) {
      longest = value.length;
    }
  }
  return longest;
}

/** True when a payload carries any recognized continuation key. */
function hasContinuation(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const keys = Object.keys(payload as Record<string, unknown>);
  return CONTINUATION_KEYS.some((key) => keys.includes(key));
}

/** `≈ N tokens`, always labelled as the estimate it is. */
function estimatedTokens(bytes: number): string {
  return `≈${Math.ceil(bytes / 4).toLocaleString()} tokens (estimate)`;
}

/** Evaluate a single predicate against the iteration transcript. */
export function evaluatePredicate(
  transcript: IterationTranscript,
  predicate: Predicate
): PredicateResult {
  switch (predicate.type) {
    case "toolCalledWith": {
      const minCount = predicate.minCount ?? 1;
      // A malformed minCount (0, negative, fractional) would otherwise disable
      // the gate (`>= 0` is always true). Fail closed instead.
      if (!Number.isInteger(minCount) || minCount < 1) {
        return fail(
          predicate,
          `invalid minCount ${String(
            predicate.minCount
          )}; expected a positive integer ≥ 1`
        );
      }
      const calls = callsTo(transcript, predicate.toolName);
      const matching = calls.filter((c) =>
        argMatch(predicate.args, c.arguments ?? {})
      );
      const mode = predicate.args.argumentMatching ?? "partial";
      if (matching.length >= minCount) {
        return pass(
          predicate,
          `tool "${predicate.toolName}" called with matching args ` +
            `(${matching.length}/${minCount} required; ${mode} match)`
        );
      }
      if (calls.length === 0) {
        return fail(
          predicate,
          `expected tool "${predicate.toolName}" called ≥${minCount}× with ` +
            `${brief(
              predicate.args.args
            )} (${mode} match), but it was never called`
        );
      }
      const shown = calls.slice(0, MAX_ITEMS_SHOWN);
      const actualArgs = shown.map((c) => brief(c.arguments ?? {}));
      const more =
        calls.length > MAX_ITEMS_SHOWN
          ? `, +${calls.length - MAX_ITEMS_SHOWN} more`
          : "";
      return fail(
        predicate,
        `expected tool "${predicate.toolName}" called ≥${minCount}× with ` +
          `${brief(predicate.args.args)} (${mode} match); got ${
            calls.length
          } ` +
          `call(s) with args [${actualArgs.join(", ")}${more}], ${
            matching.length
          } matching`
      );
    }

    case "toolCalledAtLeastOnce": {
      const calls = callsTo(transcript, predicate.toolName);
      return calls.length > 0
        ? pass(
            predicate,
            `tool "${predicate.toolName}" called ${calls.length}×`
          )
        : fail(predicate, `tool "${predicate.toolName}" was never called`);
    }

    case "firstToolWas": {
      // A missing toolName would otherwise PASS any transcript whose first call
      // happens to satisfy `undefined === undefined` after read — fail closed.
      if (
        typeof predicate.toolName !== "string" ||
        predicate.toolName.length === 0
      ) {
        return fail(predicate, `firstToolWas requires a non-empty toolName`);
      }
      const first = (transcript.toolCalls ?? [])[0];
      if (!first) {
        return fail(
          predicate,
          `expected first tool "${predicate.toolName}" but no tools were called`
        );
      }
      // Hard Constraint 4 (plan): tool calls carry `.toolName`, not `.name`.
      return first.toolName === predicate.toolName
        ? pass(predicate, `first tool call was "${predicate.toolName}"`)
        : fail(
            predicate,
            `expected first tool "${predicate.toolName}", got "${first.toolName}"`
          );
    }

    case "toolNeverCalled": {
      // A missing toolName matches no calls, which would otherwise PASS the
      // forbidden-tool check — fail closed on a malformed predicate instead.
      if (
        typeof predicate.toolName !== "string" ||
        predicate.toolName.length === 0
      ) {
        return fail(predicate, `toolNeverCalled requires a non-empty toolName`);
      }
      const calls = callsTo(transcript, predicate.toolName);
      return calls.length === 0
        ? pass(predicate, `tool "${predicate.toolName}" was not called`)
        : fail(
            predicate,
            `forbidden tool "${predicate.toolName}" was called ${calls.length}×`
          );
    }

    case "onlyToolsCalled": {
      // A non-array would make `includes` throw or silently allow substrings,
      // so fail closed rather than grade a malformed predicate.
      if (
        !Array.isArray(predicate.toolNames) ||
        predicate.toolNames.some(
          (name) => typeof name !== "string" || !name.trim()
        )
      ) {
        return fail(
          predicate,
          `onlyToolsCalled requires toolNames (array of tool names)`
        );
      }
      if (
        (transcript.toolCalls ?? []).some(
          (call) => typeof call.toolName !== "string" || !call.toolName.trim()
        )
      ) {
        return fail(
          predicate,
          "a tool call has no tool name; the allowed set cannot be verified"
        );
      }
      const allowed = new Set(predicate.toolNames);
      const offenders = [
        ...new Set(
          (transcript.toolCalls ?? [])
            .map((call) => call.toolName)
            .filter((name) => typeof name === "string" && !allowed.has(name))
        ),
      ];
      if (offenders.length > 0) {
        return fail(
          predicate,
          allowed.size === 0
            ? `expected no tool call, but ${offenders.join(", ")} was called`
            : `tool(s) outside the allowed set were called: ${offenders.join(", ")}`
        );
      }
      return pass(
        predicate,
        allowed.size === 0
          ? `no tool was called`
          : `only allowed tools were called`
      );
    }

    case "responseContains": {
      // `includes("")` is always true, so an empty/missing needle would PASS for
      // any message — fail closed on a malformed predicate instead.
      if (
        typeof predicate.needle !== "string" ||
        predicate.needle.length === 0
      ) {
        return fail(predicate, `responseContains requires a non-empty needle`);
      }
      const message = resolveFinalMessage(transcript);
      const caseSensitive = predicate.caseSensitive ?? false;
      const haystack = caseSensitive ? message : message.toLowerCase();
      const needle = caseSensitive
        ? predicate.needle
        : predicate.needle.toLowerCase();
      return haystack.includes(needle)
        ? pass(
            predicate,
            `final assistant message contains "${predicate.needle}"` +
              (caseSensitive ? " (case-sensitive)" : "")
          )
        : fail(
            predicate,
            `final assistant message does not contain "${predicate.needle}"` +
              (caseSensitive ? " (case-sensitive)" : "")
          );
    }

    case "responseMatches": {
      const message = resolveFinalMessage(transcript);
      // `new RegExp(undefined)` does not throw — it builds an empty regex that
      // matches every message. A malformed predicate (missing/empty pattern via
      // the loose `z.array(z.any())` API path) must fail closed, not silently
      // pass.
      if (
        typeof predicate.pattern !== "string" ||
        predicate.pattern.length === 0
      ) {
        return fail(
          predicate,
          `responseMatches requires a non-empty string pattern`
        );
      }
      if (NESTED_QUANTIFIER.test(predicate.pattern)) {
        return fail(
          predicate,
          `regex pattern /${predicate.pattern}/ contains a nested quantifier; refusing to evaluate to avoid catastrophic backtracking`
        );
      }
      let regex: RegExp;
      try {
        regex = new RegExp(predicate.pattern);
      } catch (error) {
        return fail(
          predicate,
          `invalid regex pattern /${predicate.pattern}/: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      if (message.length > MAX_REGEX_INPUT_CHARS) {
        return fail(
          predicate,
          `final assistant message exceeds ${MAX_REGEX_INPUT_CHARS} chars; refusing to evaluate /${predicate.pattern}/ safely`
        );
      }
      return regex.test(message)
        ? pass(
            predicate,
            `final assistant message matches /${predicate.pattern}/`
          )
        : fail(
            predicate,
            `final assistant message does not match /${predicate.pattern}/`
          );
    }

    case "noToolErrors": {
      const errors = transcript.toolErrors ?? [];
      if (errors.length === 0) {
        return pass(predicate, "no tool errors");
      }
      const detail = errors
        .slice(0, MAX_ITEMS_SHOWN)
        .map((e) => {
          const name = e.toolName ? `"${e.toolName}"` : "tool";
          const msg = e.message
            ? `: ${truncate(e.message, MAX_ERROR_MSG_CHARS)}`
            : "";
          return `${name} (${e.kind}${msg})`;
        })
        .join(", ");
      const moreErrors =
        errors.length > MAX_ITEMS_SHOWN
          ? ` (+${errors.length - MAX_ITEMS_SHOWN} more)`
          : "";
      return fail(
        predicate,
        `${errors.length} tool error(s): ${detail}${moreErrors}`
      );
    }

    case "finalAssistantMessageNonEmpty": {
      const message = resolveFinalMessage(transcript);
      return message.trim().length > 0
        ? pass(predicate, "final assistant message is non-empty")
        : fail(predicate, "final assistant message is empty");
    }

    case "tokenBudgetUnder": {
      const total = resolveTotalTokens(transcript);
      if (total === undefined) {
        // Fail closed: a gate that cannot measure usage must not silently pass.
        return fail(
          predicate,
          `token usage unavailable; cannot verify budget < ${predicate.tokens}`
        );
      }
      return total < predicate.tokens
        ? pass(predicate, `token usage ${total} < ${predicate.tokens}`)
        : fail(
            predicate,
            `token usage ${total} is not under budget ${predicate.tokens}`
          );
    }

    case "turnCountUnder": {
      const turns = transcript.turnCount;
      // Fail closed on absent OR nonsensical, same rule as `tokenBudgetUnder`:
      // a budget nobody could measure is not a budget that was met. The
      // validity check matters because callers may supply `turnCount`
      // explicitly — a negative or fractional count would otherwise sail under
      // any limit and report a pass nobody earned.
      if (turns === undefined || !Number.isInteger(turns) || turns < 0) {
        // Distinguish the two cases: "unavailable" sends a reader hunting for
        // a missing transcript, which is the wrong hunt when a caller passed a
        // real but nonsensical value.
        const why =
          turns === undefined
            ? "turn count unavailable"
            : `turn count ${turns} is not a valid count`;
        return fail(
          predicate,
          `${why}; cannot verify fewer than ${predicate.turns} user turn(s)`
        );
      }
      // STRICTLY fewer — `turnCountUnder: 3` means 2 turns pass and 3 fail.
      return turns < predicate.turns
        ? pass(
            predicate,
            `${turns} user turn(s), fewer than ${predicate.turns}`
          )
        : fail(
            predicate,
            `${turns} user turn(s) is not fewer than ${predicate.turns}`
          );
    }

    case "widgetRendered": {
      const scope = renderScope(transcript, predicate.toolName);
      if (scope.length === 0) {
        return fail(predicate, emptyScopeReason(predicate.toolName));
      }
      const rendered = scope.filter((o) => o.status === "rendered");
      return rendered.length > 0
        ? pass(
            predicate,
            `widget rendered (${rendered.length}/${scope.length} observation(s))`
          )
        : fail(
            predicate,
            `no widget rendered across ${scope.length} observation(s); ` +
              `statuses: ${describeStatuses(scope)}`
          );
    }

    case "widgetRenderLatencyUnder": {
      // A malformed budget (0, negative, fractional) would otherwise gate
      // nothing or everything arbitrarily — fail closed like tokenBudgetUnder.
      if (!Number.isInteger(predicate.ms) || predicate.ms < 1) {
        return fail(
          predicate,
          `invalid ms ${String(predicate.ms)}; expected a positive integer ≥ 1`
        );
      }
      const scope = renderScope(transcript, predicate.toolName);
      if (scope.length === 0) {
        return fail(
          predicate,
          `${emptyScopeReason(
            predicate.toolName
          )}; cannot verify render latency < ${predicate.ms}ms`
        );
      }
      const rendered = scope.filter((o) => o.status === "rendered");
      if (rendered.length === 0) {
        return fail(
          predicate,
          `no widget rendered; cannot verify render latency < ${predicate.ms}ms; ` +
            `statuses: ${describeStatuses(scope)}`
        );
      }
      const slowest = Math.max(...rendered.map((o) => o.elapsedMs));
      return slowest < predicate.ms
        ? pass(
            predicate,
            `all ${rendered.length} rendered widget(s) under ${predicate.ms}ms (slowest ${slowest}ms)`
          )
        : fail(
            predicate,
            `widget render took ${slowest}ms, not under ${predicate.ms}ms ` +
              `(${rendered.filter((o) => o.elapsedMs >= predicate.ms).length}/${
                rendered.length
              } rendered widget(s) over budget)`
          );
    }

    case "widgetNoConsoleErrors": {
      const scope = renderScope(transcript, predicate.toolName);
      if (scope.length === 0) {
        return fail(
          predicate,
          `${emptyScopeReason(
            predicate.toolName
          )}; cannot verify console errors`
        );
      }
      const offenders = scope.filter((o) => (o.consoleErrors?.length ?? 0) > 0);
      if (offenders.length === 0) {
        return pass(
          predicate,
          `no console errors across ${scope.length} observation(s)`
        );
      }
      const totalErrors = offenders.reduce(
        (sum, o) => sum + (o.consoleErrors?.length ?? 0),
        0
      );
      // Console error text is live-page-controlled data; truncate like tool
      // error messages.
      const first = truncate(
        offenders[0]?.consoleErrors?.[0] ?? "",
        MAX_ERROR_MSG_CHARS
      );
      return fail(
        predicate,
        `${totalErrors} console error(s) across ${offenders.length}/${scope.length} observation(s); first: ${first}`
      );
    }

    case "noEndingQuestion": {
      const message = resolveFinalMessage(transcript);
      if (!finalMessageEndsWithQuestion(message)) {
        return pass(predicate, "final message did not end with a question");
      }
      // The reason quotes what was seen and stops there. It does NOT say
      // "clarifying question" or "incomplete answer": this check cannot tell
      // an offer from a request for missing input, and a reason that claimed
      // otherwise would put a judgement on the author's screen that the
      // evidence does not carry.
      return fail(
        predicate,
        `final message ended with a question: "${truncate(
          lastNonEmptyLine(message),
          MAX_VALUE_CHARS
        )}"`
      );
    }

    case "toolLatencyUnder": {
      const scope = timingScope(transcript, predicate.toolName);
      const timed = callScope(transcript, predicate.toolName).length;
      if (scope.length === 0) {
        // Zero TIMED calls is a scored absence only when zero calls were
        // observed: nothing ran, so nothing was slow. Calls we watched happen
        // and did not time are a measurement we failed to take, and a ceiling
        // must not pass on one.
        const empty = emptyScopeIsScored(
          transcript,
          "toolCallTimings",
          predicate.toolName
        );
        if (!empty.scored) {
          return evidenceError(
            predicate,
            `${empty.reason}; cannot verify latency < ${predicate.ms}ms`
          );
        }
        return pass(
          predicate,
          `no calls to ${scopeLabel(
            predicate.toolName
          )}; latency budget ${predicate.ms}ms not exercised`
        );
      }
      const slowest = scope.reduce((worst, t) =>
        t.durationMs > worst.durationMs ? t : worst
      );
      const coverage = coverageNote(scope.length, timed);
      return slowest.durationMs < predicate.ms
        ? pass(
            predicate,
            `${scope.length} call(s) under ${predicate.ms}ms ` +
              `(slowest "${slowest.toolName}" at ${slowest.durationMs}ms)` +
              coverage
          )
        : fail(
            predicate,
            `"${slowest.toolName}" took ${slowest.durationMs}ms, not under ` +
              `${predicate.ms}ms (${
                scope.filter((t) => t.durationMs >= predicate.ms).length
              }/${scope.length} call(s) over budget)${coverage}`
          );
    }

    case "toolResultContains": {
      if (
        typeof predicate.needle !== "string" ||
        predicate.needle.length === 0
      ) {
        return fail(
          predicate,
          "toolResultContains requires a non-empty needle"
        );
      }
      const scope = resultScope(transcript, predicate.toolName);
      if (scope.length === 0) {
        const empty = emptyScopeIsScored(
          transcript,
          "toolResults",
          predicate.toolName
        );
        if (!empty.scored) {
          return evidenceError(
            predicate,
            `${empty.reason}; cannot look for "${truncate(
              predicate.needle,
              MAX_VALUE_CHARS
            )}"`
          );
        }
        return fail(
          predicate,
          `${scopeLabel(predicate.toolName)} returned no results to search`
        );
      }
      const caseSensitive = predicate.caseSensitive ?? false;
      const needle = caseSensitive
        ? predicate.needle
        : predicate.needle.toLowerCase();
      const hit = scope.find((result) => {
        const text = resultText(result);
        return (caseSensitive ? text : text.toLowerCase()).includes(needle);
      });
      const suffix = caseSensitive ? " (case-sensitive)" : "";
      return hit
        ? pass(
            predicate,
            `"${hit.toolName}" result contains "${truncate(
              predicate.needle,
              MAX_VALUE_CHARS
            )}"${suffix}`
          )
        : fail(
            predicate,
            `no result from ${scopeLabel(
              predicate.toolName
            )} contains "${truncate(
              predicate.needle,
              MAX_VALUE_CHARS
            )}"${suffix} (${scope.length} result(s) searched)`
          );
    }

    case "toolResultMatchesSchema": {
      const scope = resultScope(transcript, predicate.toolName);
      if (scope.length === 0) {
        const empty = emptyScopeIsScored(
          transcript,
          "toolResults",
          predicate.toolName
        );
        if (!empty.scored) {
          return evidenceError(
            predicate,
            `${empty.reason}; cannot validate against the authored schema`
          );
        }
        return fail(
          predicate,
          `${scopeLabel(predicate.toolName)} returned no results to validate`
        );
      }
      const failures: string[] = [];
      for (const result of scope) {
        const payload = resultPayload(result);
        if (!payload.found) {
          failures.push(`"${result.toolName}" result was not JSON`);
          continue;
        }
        const validation = validateAgainstSchema(
          predicate.schema,
          payload.value
        );
        if (validation.outcome === "valid") continue;
        if (validation.outcome === "unsupported-dialect") {
          // OUR gap, not the server's data. Reported as an error so it cannot
          // read as "the server returned the wrong shape".
          return evidenceError(
            predicate,
            `authored schema declares dialect "${validation.dialect}", which ` +
              "this validator does not carry; nothing was validated"
          );
        }
        if (validation.outcome === "unusable-schema") {
          return evidenceError(
            predicate,
            `authored schema is unusable: ${validation.message}`
          );
        }
        const first = validation.violations[0];
        failures.push(
          `"${result.toolName}"${first?.at ? ` at ${first.at}` : ""}: ${
            first?.message ?? "did not match the schema"
          }`
        );
      }
      if (failures.length === 0) {
        return pass(
          predicate,
          `${scope.length} result(s) from ${scopeLabel(
            predicate.toolName
          )} match the authored schema`
        );
      }
      const shown = failures.slice(0, MAX_ITEMS_SHOWN).join("; ");
      const more =
        failures.length > MAX_ITEMS_SHOWN
          ? ` (+${failures.length - MAX_ITEMS_SHOWN} more)`
          : "";
      return fail(
        predicate,
        `${failures.length}/${scope.length} result(s) did not match: ${shown}${more}`
      );
    }

    case "toolResultSizeUnder": {
      const scope = resultScope(transcript, predicate.toolName);
      const returned = callScope(transcript, predicate.toolName).length;
      if (scope.length === 0) {
        const empty = emptyScopeIsScored(
          transcript,
          "toolResults",
          predicate.toolName
        );
        if (!empty.scored) {
          return evidenceError(
            predicate,
            `${empty.reason}; cannot verify size < ${predicate.maxBytes} bytes`
          );
        }
        return pass(
          predicate,
          `no results from ${scopeLabel(
            predicate.toolName
          )}; size budget ${predicate.maxBytes} bytes not exercised`
        );
      }
      // A row we could not measure is not a small row. One unmeasured result
      // makes the whole check unscorable rather than silently narrowing the
      // budget to the rows that happened to carry a number.
      const unmeasured = scope.filter((r) => r.size?.complete !== true);
      if (unmeasured.length > 0) {
        return evidenceError(
          predicate,
          `${unmeasured.length}/${scope.length} result(s) carry no complete ` +
            `size measurement (first: "${unmeasured[0]?.toolName}"); ` +
            `cannot verify size < ${predicate.maxBytes} bytes`
        );
      }
      const largest = scope.reduce((worst, r) =>
        r.size.bytes > worst.size.bytes ? r : worst
      );
      const basis = largest.size.basis;
      return largest.size.bytes < predicate.maxBytes
        ? pass(
            predicate,
            `largest result "${largest.toolName}" is ` +
              `${largest.size.bytes.toLocaleString()} bytes ` +
              `(${basis}, ${estimatedTokens(largest.size.bytes)}), ` +
              `under ${predicate.maxBytes.toLocaleString()}` +
              coverageNote(scope.length, returned)
          )
        : fail(
            predicate,
            `result "${largest.toolName}" is ` +
              `${largest.size.bytes.toLocaleString()} bytes ` +
              `(${basis}, ${estimatedTokens(largest.size.bytes)}), not under ` +
              `${predicate.maxBytes.toLocaleString()}` +
              coverageNote(scope.length, returned)
          );
    }

    case "argumentsMatchToolSchema": {
      const calls = callScope(transcript, predicate.toolName);
      if (captureState(transcript, "toolInventory") !== "complete") {
        return evidenceError(
          predicate,
          "no tool inventory captured; cannot compare arguments against a " +
            "schema the run never recorded"
        );
      }
      if (calls.length === 0) {
        return pass(
          predicate,
          `no calls to ${scopeLabel(predicate.toolName)} to validate`
        );
      }
      const failures: string[] = [];
      const undeclared = new Set<string>();
      for (const call of calls) {
        const tool = inventoryEntry(transcript, call.toolName);
        if (!tool) {
          return evidenceError(
            predicate,
            `tool "${call.toolName}" was called but is not in the captured ` +
              "inventory; cannot validate its arguments"
          );
        }
        if (tool.inputSchema === undefined) {
          return evidenceError(
            predicate,
            `tool "${call.toolName}" declares no inputSchema; there is no ` +
              "contract to validate against"
          );
        }
        // A key absent from `properties` is NOT a violation: JSON Schema
        // allows additional properties by default, and only a schema that
        // closes the object (`additionalProperties: false`) forbids one. Such
        // keys are surfaced for the author's eye and never fail the check —
        // the validator itself decides what is a violation.
        const schema = tool.inputSchema as Record<string, unknown>;
        const declared =
          schema && typeof schema === "object" && schema.properties
            ? Object.keys(schema.properties as Record<string, unknown>)
            : [];
        for (const key of Object.keys(call.arguments ?? {})) {
          if (declared.length > 0 && !declared.includes(key)) {
            undeclared.add(key);
          }
        }
        const validation = validateAgainstSchema(
          tool.inputSchema,
          call.arguments ?? {}
        );
        if (validation.outcome === "valid") continue;
        if (validation.outcome === "unsupported-dialect") {
          return evidenceError(
            predicate,
            `tool "${call.toolName}" declares JSON Schema dialect ` +
              `"${validation.dialect}", which this validator does not carry`
          );
        }
        if (validation.outcome === "unusable-schema") {
          return evidenceError(
            predicate,
            `tool "${call.toolName}" declares an unusable inputSchema: ` +
              validation.message
          );
        }
        for (const violation of validation.violations.slice(
          0,
          MAX_ITEMS_SHOWN
        )) {
          failures.push(
            `"${call.toolName}" ${violation.class}` +
              `${violation.at && violation.at !== "#" ? ` at ${violation.at}` : ""}`
          );
        }
      }
      const note =
        undeclared.size > 0
          ? ` (undeclared keys, allowed by the schema: ${[...undeclared]
              .slice(0, MAX_ITEMS_SHOWN)
              .join(", ")})`
          : "";
      if (failures.length === 0) {
        return pass(
          predicate,
          `${calls.length} call(s) match the declared inputSchema${note}` +
            "; schema validity does not establish that the arguments match " +
            "the user's intent"
        );
      }
      const shown = failures.slice(0, MAX_ITEMS_SHOWN).join("; ");
      const more =
        failures.length > MAX_ITEMS_SHOWN
          ? ` (+${failures.length - MAX_ITEMS_SHOWN} more)`
          : "";
      return fail(
        predicate,
        `${failures.length} schema violation(s): ${shown}${more}${note}`
      );
    }

    case "noRepeatedIdenticalCall": {
      // Adjacency is a property of the TRANSCRIPT, so it is read off the full
      // call list. Scoping narrows which repeat is REPORTED; it must not
      // change what "back-to-back" means, and filtering first would do exactly
      // that — splicing out the calls between two identical ones and reporting
      // a repeat that never happened.
      const calls = transcript.toolCalls ?? [];
      for (let i = 1; i < calls.length; i++) {
        const previous = calls[i - 1]!;
        const current = calls[i]!;
        if (previous.toolName !== current.toolName) continue;
        if (
          predicate.toolName !== undefined &&
          current.toolName !== predicate.toolName
        ) {
          continue;
        }
        if (canonicalArgs(previous, i - 1) !== canonicalArgs(current, i)) {
          continue;
        }
        // The label says WHAT WAS SEEN. A poll loop and a retry after a
        // transient failure are this exact shape and both are correct, so the
        // reason must not call it waste.
        return fail(
          predicate,
          `an identical call was repeated back-to-back: "${current.toolName}" ` +
            `with ${brief(current.arguments ?? {})}`
        );
      }
      return pass(
        predicate,
        `no identical call to ${scopeLabel(
          predicate.toolName
        )} was repeated back-to-back`
      );
    }

    case "toolCallCountUnder": {
      const calls = callScope(transcript, predicate.toolName);
      return calls.length < predicate.count
        ? pass(
            predicate,
            `${calls.length} call(s) to ${scopeLabel(
              predicate.toolName
            )}, fewer than ${predicate.count}`
          )
        : fail(
            predicate,
            `${calls.length} call(s) to ${scopeLabel(
              predicate.toolName
            )} is not fewer than ${predicate.count}`
          );
    }

    case "toolCalledBefore": {
      if (
        typeof predicate.toolName !== "string" ||
        predicate.toolName.length === 0 ||
        typeof predicate.beforeToolName !== "string" ||
        predicate.beforeToolName.length === 0
      ) {
        return fail(
          predicate,
          "toolCalledBefore requires non-empty toolName and beforeToolName"
        );
      }
      const calls = transcript.toolCalls ?? [];
      let seenPrerequisite = false;
      let checked = 0;
      for (const call of calls) {
        if (call.toolName === predicate.toolName) seenPrerequisite = true;
        if (call.toolName !== predicate.beforeToolName) continue;
        checked += 1;
        if (!seenPrerequisite) {
          return fail(
            predicate,
            `"${predicate.beforeToolName}" was called before any ` +
              `"${predicate.toolName}"`
          );
        }
      }
      // Vacuously true: the rule constrains calls that did not happen.
      return checked === 0
        ? pass(
            predicate,
            `"${predicate.beforeToolName}" was never called, so the ordering ` +
              "rule has nothing to violate"
          )
        : pass(
            predicate,
            `all ${checked} "${predicate.beforeToolName}" call(s) followed a ` +
              `"${predicate.toolName}" call`
          );
    }

    case "noDeprecatedToolCalled": {
      if (captureState(transcript, "toolInventory") !== "complete") {
        return evidenceError(
          predicate,
          "no tool inventory captured; cannot read tool descriptions"
        );
      }
      const called = new Set(
        (transcript.toolCalls ?? []).map((c) => c.toolName)
      );
      for (const name of called) {
        const tool = inventoryEntry(transcript, name);
        if (describesItselfAsDeprecated(tool?.description)) {
          return fail(
            predicate,
            `a tool whose description marks it deprecated was called: "${name}"`
          );
        }
      }
      return pass(
        predicate,
        "no called tool's description marks it deprecated"
      );
    }

    case "noDestructiveToolCalled": {
      if (captureState(transcript, "toolInventory") !== "complete") {
        return evidenceError(
          predicate,
          "no tool inventory captured; cannot read destructiveHint"
        );
      }
      const inventory = transcript.toolInventory ?? [];
      // A DECLARATION nobody made is not a declaration of safety. Passing on
      // an inventory with no annotations at all would read as "nothing
      // destructive was called", which the run cannot support.
      if (!inventory.some((tool) => tool.annotations !== undefined)) {
        return evidenceError(
          predicate,
          "no tool in the inventory declares annotations; destructiveHint " +
            "was never stated, so it cannot be checked"
        );
      }
      const called = new Set(
        (transcript.toolCalls ?? []).map((c) => c.toolName)
      );
      for (const name of called) {
        if (inventoryEntry(transcript, name)?.annotations?.destructiveHint) {
          return fail(
            predicate,
            `a tool declaring destructiveHint was called: "${name}"`
          );
        }
      }
      return pass(predicate, "no tool declaring destructiveHint was called");
    }

    case "toolErrorNamesInput": {
      const errors = (transcript.toolErrors ?? []).filter(
        (e) =>
          predicate.toolName === undefined || e.toolName === predicate.toolName
      );
      if (errors.length === 0) {
        return pass(
          predicate,
          `no errors from ${scopeLabel(predicate.toolName)} to inspect`
        );
      }
      if (captureState(transcript, "toolInventory") !== "complete") {
        return evidenceError(
          predicate,
          "no tool inventory captured; cannot tell an input key from any " +
            "other word in the message"
        );
      }
      for (const error of errors) {
        const message = (error.message ?? "").toLowerCase();
        if (message.length === 0) {
          return fail(
            predicate,
            `a tool error carried no message at all${
              error.toolName ? ` ("${error.toolName}")` : ""
            }`
          );
        }
        const tool = error.toolName
          ? inventoryEntry(transcript, error.toolName)
          : undefined;
        const schema = tool?.inputSchema as Record<string, unknown> | undefined;
        const keys =
          schema && typeof schema === "object" && schema.properties
            ? Object.keys(schema.properties as Record<string, unknown>)
            : [];
        // A declared key is a property of the TOOL, so it reads soundly
        // whichever call failed.
        if (keys.some((key) => message.includes(key.toLowerCase()))) continue;
        // A sent VALUE is a property of ONE call, and may only be read off the
        // call that failed: the id join, or the only call to that tool.
        const candidates = (transcript.toolCalls ?? []).filter(
          (c) => !error.toolName || c.toolName === error.toolName
        );
        const joined =
          (error.toolCallId === undefined
            ? undefined
            : candidates.find((c) => c.toolCallId === error.toolCallId)) ??
          (candidates.length === 1 ? candidates[0] : undefined);
        const sent = (joined ? [joined] : candidates)
          .flatMap((c) => Object.values(c.arguments ?? {}))
          .filter(
            (value): value is string | number =>
              (typeof value === "string" && value.length >= 3) ||
              typeof value === "number"
          )
          .map((value) => String(value).toLowerCase());
        const names = sent.some((value) => message.includes(value));
        if (names && !joined) {
          // Some call to this tool sent that value and nothing says it was
          // this one's. Crediting the server for naming an input it may never
          // have been given is the attribution this evaluator must not
          // manufacture — so the row is unscorable, not a pass.
          return evidenceError(
            predicate,
            `a tool error names a value sent by one of ${candidates.length} ` +
              `calls to "${error.toolName}" and carries no call id; cannot ` +
              "tell whether it named its own input"
          );
        }
        if (!names) {
          // WHAT WAS SEEN, and no more. Naming an input is not the same as
          // recovery quality: "Rate limited. Retry in 30 seconds." names
          // nothing and is exemplary.
          return fail(
            predicate,
            `a tool error did not name an input${
              error.toolName ? ` ("${error.toolName}")` : ""
            }: ${truncate(error.message ?? "", MAX_ERROR_MSG_CHARS)}`
          );
        }
      }
      return pass(
        predicate,
        `all ${errors.length} tool error(s) named an input key or a sent value`
      );
    }

    case "fullPageHasContinuation": {
      if (captureState(transcript, "toolResults") !== "complete") {
        return evidenceError(
          predicate,
          "no tool results captured; cannot tell a full page from a short one"
        );
      }
      const calls = callScope(transcript, predicate.toolName);
      const results = transcript.toolResults ?? [];
      // A page is graded against ITS OWN result. Matching by name alone pairs
      // every call with the FIRST result of that tool, so page two is graded
      // against page one's payload — a missing continuation reported on the
      // wrong request, or a real one missed. Call ids join them exactly; where
      // the capture carries none, same-named results are consumed in call
      // order, each at most once. A call that carries an id in an
      // id-carrying capture and matches nothing produced no result: it is
      // skipped rather than handed the next call's page.
      const fullyIdJoined =
        results.length > 0 && results.every((r) => r.toolCallId !== undefined);
      const consumed = new Set<number>();
      const resultFor = (
        call: TranscriptToolCall
      ): TranscriptToolResult | undefined => {
        const take = (index: number): TranscriptToolResult | undefined => {
          if (index < 0) return undefined;
          consumed.add(index);
          return results[index];
        };
        if (call.toolCallId !== undefined) {
          const byId = results.findIndex(
            (r) => r.toolCallId === call.toolCallId
          );
          if (byId >= 0) return take(byId);
          // Where every row carries an id, no match means this call produced
          // no result at all — it is skipped, not handed another call's page.
          if (fullyIdJoined) return undefined;
        }
        return take(
          results.findIndex(
            (r, index) => !consumed.has(index) && r.toolName === call.toolName
          )
        );
      };
      let inspected = 0;
      for (const call of calls) {
        // Every call consumes its row, limit or not: skipping one would shift
        // the pairing for every call after it.
        const result = resultFor(call);
        const limit = requestedLimit(call);
        if (limit === undefined) continue;
        if (!result) continue;
        const payload = resultPayload(result);
        if (!payload.found) continue;
        const length = longestTopLevelArray(payload.value);
        if (length === undefined || length !== limit) continue;
        inspected += 1;
        if (!hasContinuation(payload.value)) {
          // NOT "truncated": a full page does not prove more results exist.
          return fail(
            predicate,
            `a full page carried no continuation metadata: "${call.toolName}" ` +
              `returned ${length} result(s) against a requested limit of ${limit}`
          );
        }
      }
      return pass(
        predicate,
        inspected === 0
          ? `no full page from ${scopeLabel(predicate.toolName)} to inspect`
          : `all ${inspected} full page(s) carried continuation metadata`
      );
    }

    default: {
      // Exhaustiveness guard: a new Predicate variant must add a case above.
      const exhaustive: never = predicate;
      return {
        predicate: exhaustive,
        passed: false,
        reason: `unknown predicate type`,
      };
    }
  }
}

/** Evaluate every predicate, preserving order. */
export function evaluatePredicates(
  transcript: IterationTranscript,
  predicates: Predicate[] | undefined
): PredicateResult[] {
  return (predicates ?? []).map((p) => {
    try {
      return evaluatePredicate(transcript, p);
    } catch (error) {
      // A malformed predicate (e.g. from a loosely-typed API payload missing
      // required fields) must fail closed like an unknown type — never abort
      // the whole iteration's finalization.
      return {
        predicate: p,
        passed: false,
        reason: `malformed predicate: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  });
}

/**
 * Case verdict from predicate results: passes iff **all gating** predicates
 * pass. Advisory results are recorded and never fail the trial. An empty
 * gating set passes vacuously.
 */
export function allPredicatesPassed(results: PredicateResult[]): boolean {
  return results.every(
    (r) => r.passed || checkRole(r.predicate) === "advisory"
  );
}

/** One prompt turn's checks plus the turn-scoped transcript to run them on. */
export interface TurnChecksInput {
  /** Zero-based index of the turn in the case's `promptTurns`. */
  promptIndex: number;
  /** The turn's per-turn checks (already restricted to turn-scopable kinds). */
  checks: Predicate[] | undefined;
  /** The turn-scoped transcript (see `buildTurnTranscript`). */
  transcript: IterationTranscript;
}

/**
 * Evaluate per-turn checks across a case's turns, reusing the same
 * {@link evaluatePredicates} engine against each turn's slice. Every result is
 * tagged with `scope: { kind: "turn", promptIndex }` so the UI and persisted
 * metadata can attribute it to the turn. Turns with no checks contribute
 * nothing. Order is preserved (turn order, then check order within a turn).
 *
 * Defense in depth: non-turn-scopable kinds (e.g. `tokenBudgetUnder`) are
 * dropped here even though the backend rejects them at the write boundary —
 * the evaluator must never silently treat a case-only check as turn-scoped if
 * one reaches it directly (a different write path, a test, a future caller).
 */
export function evaluateTurnChecks(
  turns: TurnChecksInput[]
): PredicateResult[] {
  const results: PredicateResult[] = [];
  for (const turn of turns) {
    if (!turn.checks || turn.checks.length === 0) continue;
    const turnScopable = turn.checks.filter((check) =>
      isTurnScopablePredicateKind(check.type)
    );
    for (const result of evaluatePredicates(turn.transcript, turnScopable)) {
      results.push({
        ...result,
        scope: { kind: "turn", promptIndex: turn.promptIndex },
      });
    }
  }
  return results;
}
