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
  RenderObservationSummary,
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
  toolName: string,
): TranscriptToolCall[] {
  return (transcript.toolCalls ?? []).filter((c) => c.toolName === toolName);
}

function resolveFinalMessage(transcript: IterationTranscript): string {
  return typeof transcript.finalAssistantMessage === "string"
    ? transcript.finalAssistantMessage
    : "";
}

/**
 * The render observations a `widget*` predicate evaluates over: all of the
 * iteration's observations, narrowed to `toolName` when the predicate sets it.
 * Every `widget*` predicate fails closed on an empty scope — no observations
 * means the check cannot attest, which must not read as a pass.
 */
function renderScope(
  transcript: IterationTranscript,
  toolName: string | undefined,
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
          `expected first tool "${predicate.toolName}" but no tools were called`,
        );
      }
      // Hard Constraint 4 (plan): tool calls carry `.toolName`, not `.name`.
      return first.toolName === predicate.toolName
        ? pass(
            predicate,
            `first tool call was "${predicate.toolName}"`,
          )
        : fail(
            predicate,
            `expected first tool "${predicate.toolName}", got "${first.toolName}"`,
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
            `forbidden tool "${predicate.toolName}" was called ${calls.length}×`,
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
          `responseMatches requires a non-empty string pattern`,
        );
      }
      if (NESTED_QUANTIFIER.test(predicate.pattern)) {
        return fail(
          predicate,
          `regex pattern /${predicate.pattern}/ contains a nested quantifier; refusing to evaluate to avoid catastrophic backtracking`,
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

    case "widgetRendered": {
      const scope = renderScope(transcript, predicate.toolName);
      if (scope.length === 0) {
        return fail(predicate, emptyScopeReason(predicate.toolName));
      }
      const rendered = scope.filter((o) => o.status === "rendered");
      return rendered.length > 0
        ? pass(
            predicate,
            `widget rendered (${rendered.length}/${scope.length} observation(s))`,
          )
        : fail(
            predicate,
            `no widget rendered across ${scope.length} observation(s); ` +
              `statuses: ${describeStatuses(scope)}`,
          );
    }

    case "widgetRenderLatencyUnder": {
      // A malformed budget (0, negative, fractional) would otherwise gate
      // nothing or everything arbitrarily — fail closed like tokenBudgetUnder.
      if (!Number.isInteger(predicate.ms) || predicate.ms < 1) {
        return fail(
          predicate,
          `invalid ms ${String(predicate.ms)}; expected a positive integer ≥ 1`,
        );
      }
      const scope = renderScope(transcript, predicate.toolName);
      if (scope.length === 0) {
        return fail(
          predicate,
          `${emptyScopeReason(predicate.toolName)}; cannot verify render latency < ${predicate.ms}ms`,
        );
      }
      const rendered = scope.filter((o) => o.status === "rendered");
      if (rendered.length === 0) {
        return fail(
          predicate,
          `no widget rendered; cannot verify render latency < ${predicate.ms}ms; ` +
            `statuses: ${describeStatuses(scope)}`,
        );
      }
      const slowest = Math.max(...rendered.map((o) => o.elapsedMs));
      return slowest < predicate.ms
        ? pass(
            predicate,
            `all ${rendered.length} rendered widget(s) under ${predicate.ms}ms (slowest ${slowest}ms)`,
          )
        : fail(
            predicate,
            `widget render took ${slowest}ms, not under ${predicate.ms}ms ` +
              `(${rendered.filter((o) => o.elapsedMs >= predicate.ms).length}/${rendered.length} rendered widget(s) over budget)`,
          );
    }

    case "widgetNoConsoleErrors": {
      const scope = renderScope(transcript, predicate.toolName);
      if (scope.length === 0) {
        return fail(
          predicate,
          `${emptyScopeReason(predicate.toolName)}; cannot verify console errors`,
        );
      }
      const offenders = scope.filter(
        (o) => (o.consoleErrors?.length ?? 0) > 0,
      );
      if (offenders.length === 0) {
        return pass(
          predicate,
          `no console errors across ${scope.length} observation(s)`,
        );
      }
      const totalErrors = offenders.reduce(
        (sum, o) => sum + (o.consoleErrors?.length ?? 0),
        0,
      );
      // Console error text is live-page-controlled data; truncate like tool
      // error messages.
      const first = truncate(
        offenders[0]?.consoleErrors?.[0] ?? "",
        MAX_ERROR_MSG_CHARS,
      );
      return fail(
        predicate,
        `${totalErrors} console error(s) across ${offenders.length}/${scope.length} observation(s); first: ${first}`,
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
