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
import type {
  IterationTranscript,
  Predicate,
  PredicateResult,
  TranscriptToolCall,
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
  toolName: string,
): TranscriptToolCall[] {
  return (transcript.toolCalls ?? []).filter((c) => c.toolName === toolName);
}

function resolveFinalMessage(transcript: IterationTranscript): string {
  return typeof transcript.finalAssistantMessage === "string"
    ? transcript.finalAssistantMessage
    : "";
}

function resolveTotalTokens(transcript: IterationTranscript): number | undefined {
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

function pass(predicate: Predicate, reason: string): PredicateResult {
  return { predicate, passed: true, reason: truncate(reason, MAX_REASON_CHARS) };
}

function fail(predicate: Predicate, reason: string): PredicateResult {
  return { predicate, passed: false, reason: truncate(reason, MAX_REASON_CHARS) };
}

/** Evaluate a single predicate against the iteration transcript. */
export function evaluatePredicate(
  transcript: IterationTranscript,
  predicate: Predicate,
): PredicateResult {
  switch (predicate.type) {
    case "toolCalledWith": {
      const minCount = predicate.minCount ?? 1;
      // A malformed minCount (0, negative, fractional) would otherwise disable
      // the gate (`>= 0` is always true). Fail closed instead.
      if (!Number.isInteger(minCount) || minCount < 1) {
        return fail(
          predicate,
          `invalid minCount ${String(predicate.minCount)}; expected a positive integer ≥ 1`,
        );
      }
      const calls = callsTo(transcript, predicate.toolName);
      const matching = calls.filter((c) =>
        argMatch(predicate.args, c.arguments ?? {}),
      );
      const mode = predicate.args.argumentMatching ?? "partial";
      if (matching.length >= minCount) {
        return pass(
          predicate,
          `tool "${predicate.toolName}" called with matching args ` +
            `(${matching.length}/${minCount} required; ${mode} match)`,
        );
      }
      if (calls.length === 0) {
        return fail(
          predicate,
          `expected tool "${predicate.toolName}" called ≥${minCount}× with ` +
            `${brief(predicate.args.args)} (${mode} match), but it was never called`,
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
          `${brief(predicate.args.args)} (${mode} match); got ${calls.length} ` +
          `call(s) with args [${actualArgs.join(", ")}${more}], ${matching.length} matching`,
      );
    }

    case "toolCalledAtLeastOnce": {
      const calls = callsTo(transcript, predicate.toolName);
      return calls.length > 0
        ? pass(predicate, `tool "${predicate.toolName}" called ${calls.length}×`)
        : fail(predicate, `tool "${predicate.toolName}" was never called`);
    }

    case "toolNeverCalled": {
      const calls = callsTo(transcript, predicate.toolName);
      return calls.length === 0
        ? pass(predicate, `tool "${predicate.toolName}" was not called`)
        : fail(
            predicate,
            `forbidden tool "${predicate.toolName}" was called ${calls.length}×`,
          );
    }

    case "responseContains": {
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
              (caseSensitive ? " (case-sensitive)" : ""),
          )
        : fail(
            predicate,
            `final assistant message does not contain "${predicate.needle}"` +
              (caseSensitive ? " (case-sensitive)" : ""),
          );
    }

    case "responseMatches": {
      const message = resolveFinalMessage(transcript);
      let regex: RegExp;
      try {
        regex = new RegExp(predicate.pattern);
      } catch (error) {
        return fail(
          predicate,
          `invalid regex pattern /${predicate.pattern}/: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (message.length > MAX_REGEX_INPUT_CHARS) {
        return fail(
          predicate,
          `final assistant message exceeds ${MAX_REGEX_INPUT_CHARS} chars; refusing to evaluate /${predicate.pattern}/ safely`,
        );
      }
      return regex.test(message)
        ? pass(predicate, `final assistant message matches /${predicate.pattern}/`)
        : fail(
            predicate,
            `final assistant message does not match /${predicate.pattern}/`,
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
        `${errors.length} tool error(s): ${detail}${moreErrors}`,
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
          `token usage unavailable; cannot verify budget < ${predicate.tokens}`,
        );
      }
      return total < predicate.tokens
        ? pass(predicate, `token usage ${total} < ${predicate.tokens}`)
        : fail(
            predicate,
            `token usage ${total} is not under budget ${predicate.tokens}`,
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
  predicates: Predicate[] | undefined,
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
 * Case verdict from predicate results: passes iff **all** pass. An empty set
 * passes vacuously (a case with no predicates is not gated by predicates).
 */
export function allPredicatesPassed(results: PredicateResult[]): boolean {
  return results.every((r) => r.passed);
}
