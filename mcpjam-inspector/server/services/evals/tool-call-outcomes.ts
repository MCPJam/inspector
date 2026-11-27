/**
 * Tool-call outcomes for one hosted iteration, read off the matcher's own
 * lists: which expected calls were missing or over the extras cap, which
 * paired calls had the wrong arguments, and the bounded reason line for each.
 * Names and counts only, never argument values.
 */

import { evaluateToolCalls } from "@mcpjam/sdk/matchers";
import { resolveExtrasCap } from "@/shared/eval-matching";
import type {
  HostedEvaluationLike,
  HostedMatcherTurnLike,
} from "./score-rows.js";

function matcherTurns(
  evaluation: HostedEvaluationLike,
): readonly HostedMatcherTurnLike[] {
  return evaluation.promptSummaries?.length
    ? evaluation.promptSummaries
    : [evaluation];
}

export type ToolSelectionOutcome = {
  passed: boolean;
  missing: number;
  /** Extra calls in the turns that went past the cap. */
  extrasOverCap: number;
  cap: number | null;
};

/**
 * `toolCalls:match` (v3): per turn, no expected call missing and no more
 * extra calls than `maxExtraToolCalls` allows.
 *
 * Read off the matcher's OWN lists, never re-matched: a same-name call with
 * the wrong arguments is paired by the matcher and reported as an argument
 * mismatch, not as missing, so it lands on `toolCalls:arguments` and leaves
 * this verdict alone. Order folds in through the same lists — a strict or
 * superset miss leaves the expected call unpaired.
 */
export function toolSelectionOutcome(
  evaluation: HostedEvaluationLike,
  matchOptions: Record<string, unknown> | undefined,
): ToolSelectionOutcome {
  const cap = resolveExtrasCap(matchOptions);
  let missing = 0;
  let extrasOverCap = 0;
  for (const turn of matcherTurns(evaluation)) {
    missing += turn.missing?.length ?? 0;
    const extras = turn.unexpected?.length ?? 0;
    if (cap !== null && extras > cap) extrasOverCap += extras;
  }
  return {
    passed: missing === 0 && extrasOverCap === 0,
    missing,
    extrasOverCap,
    cap,
  };
}

/** A negative case's selection verdict: every call breaks it. */
export function negativeSelection(evaluation: HostedEvaluationLike): {
  passed: boolean;
  reason: string;
} {
  const calls = evaluation.unexpected?.length ?? 0;
  return calls === 0
    ? { passed: true, reason: "no tool was called, as the case expects" }
    : {
        passed: false,
        reason: `${calls} tool call(s) made where the case expects none`,
      };
}

/** Bounded, content-free summary of the selection verdict. Counts only. */
export function describeToolSelection(outcome: ToolSelectionOutcome): string {
  if (outcome.passed) return "every expected tool was called";
  const parts: string[] = [];
  if (outcome.missing > 0) parts.push(`${outcome.missing} missing`);
  if (outcome.extrasOverCap > 0) {
    parts.push(
      `${outcome.extrasOverCap} unexpected (at most ${outcome.cap} allowed per turn)`,
    );
  }
  return `tool selection unmet: ${parts.join(", ")}`;
}

type ArgumentMismatchLike = {
  toolName?: unknown;
  expectedArgs?: unknown;
  actualArgs?: unknown;
};

export type ToolArgumentsOutcome = {
  /** Expected calls the matcher paired with a call, rightly or wrongly. */
  compared: number;
  mismatches: Array<{ turn?: number; toolName: string; keys: string[] }>;
};

/**
 * `toolCalls:arguments`: every expected call the matcher paired with an actual
 * one was made with the expected arguments.
 *
 * The verdict is the matcher's own `argumentMismatches`. The argument NAMES
 * each mismatch reports are recovered only for the reason line, and through
 * the same matcher, one expected key at a time, so a placeholder like
 * `"string"` means here what it meant there.
 */
export function toolArgumentsOutcome(
  evaluation: HostedEvaluationLike,
  matchOptions: Record<string, unknown> | undefined,
): ToolArgumentsOutcome {
  const turns = matcherTurns(evaluation);
  const numbered = turns.length > 1;
  let compared = 0;
  const mismatches: ToolArgumentsOutcome["mismatches"] = [];
  for (const turn of turns) {
    compared += Math.max(
      0,
      (turn.expectedToolCalls?.length ?? 0) - (turn.missing?.length ?? 0),
    );
    for (const raw of turn.argumentMismatches ?? []) {
      const mismatch = (raw ?? {}) as ArgumentMismatchLike;
      const toolName =
        typeof mismatch.toolName === "string" ? mismatch.toolName : "a tool";
      mismatches.push({
        ...(numbered && typeof turn.promptIndex === "number"
          ? { turn: turn.promptIndex + 1 }
          : {}),
        toolName,
        keys: mismatchedKeys(mismatch, matchOptions),
      });
    }
  }
  // A mismatch is itself a compared call; count it even when the turn did
  // not report its expectations.
  return { compared: Math.max(compared, mismatches.length), mismatches };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The argument names that differ, by the matcher's own rules. Names only. */
function mismatchedKeys(
  mismatch: ArgumentMismatchLike,
  matchOptions: Record<string, unknown> | undefined,
): string[] {
  const expected = recordOf(mismatch.expectedArgs);
  const actual = recordOf(mismatch.actualArgs);
  const exact = matchOptions?.argumentMatching === "exact";
  const keys = exact
    ? [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    : Object.keys(expected);
  return keys
    .filter((key) => {
      const one = (args: Record<string, unknown>) =>
        key in args ? { [key]: args[key] } : {};
      return (
        evaluateToolCalls(
          [{ toolName: "t", arguments: one(expected) }],
          [{ toolName: "t", arguments: one(actual) }],
          { argumentMatching: exact ? "exact" : "partial" },
        ).argumentMismatches.length > 0
      );
    })
    .sort();
}

const MAX_NAMED_MISMATCHES = 3;

/** Names the tool and the argument, never a value: values can be anything. */
export function describeToolArguments(outcome: ToolArgumentsOutcome): string {
  if (outcome.mismatches.length === 0) {
    return outcome.compared === 0
      ? "no expected call was matched, so there were no arguments to compare"
      : "every expected tool was called with the expected arguments";
  }
  const named = outcome.mismatches
    .slice(0, MAX_NAMED_MISMATCHES)
    .map(({ turn, toolName, keys }) => {
      const where = turn !== undefined ? `turn ${turn}: ` : "";
      const names = keys.map((key) => `\`${key}\``).join(", ");
      const what =
        keys.length === 0
          ? "different arguments"
          : keys.length === 1
            ? `a different ${names}`
            : `different ${names}`;
      return `${where}\`${toolName}\` was called with ${what} than expected`;
    });
  const rest = outcome.mismatches.length - named.length;
  return rest > 0 ? `${named.join("; ")}; and ${rest} more` : named.join("; ");
}
