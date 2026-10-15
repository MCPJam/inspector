import {
  describeError,
  originOf,
  redactForTelemetry,
  type ErrorOrigin,
} from "@mcpjam/sdk/browser";
import type {
  EvalRunDecisionChain,
  EvalRunDecisionDiagnostic,
  StageReason,
} from "@mcpjam/sdk/contract";

import {
  isPinnedTurn,
  normalizeSteps,
  stepsToPromptTurns,
} from "@/shared/steps";
import type { EvalIteration } from "../evals/types";
import { chainForQuickRunIteration } from "./simple-case/quick-run-chain";

/** Recorded error categories. */
export type RunErrorCause =
  | "serverUnreachable"
  | "serverError"
  | "testInput"
  | "settings"
  | "platform"
  | "unknown";

export type RunErrorGroup = {
  cause: RunErrorCause;
  title: string;
  count: number;
  errors: Array<{ message: string; count: number }>;
};

export type RunErrorBreakdown = {
  errored: number;
  /** Results that finished, errored or not. The denominator of the headline. */
  finished: number;
  headline: string;
  groups: RunErrorGroup[];
};

const CAUSE_COPY: Record<RunErrorCause, string> = {
  serverUnreachable: "Couldn't connect to your MCP server",
  serverError: "Your MCP server returned an error",
  testInput: "Your server rejected the tool inputs saved in the test",
  settings: "A test or workspace setting stopped the run",
  platform: "MCPJam or the AI model provider failed",
  unknown: "The cause wasn't recorded",
};

/** Lifecycle states that never finished, so they are neither errors nor passes. */
const UNFINISHED_STATUSES = new Set<EvalIteration["status"]>([
  "pending",
  "running",
  "cancelled",
  "skipped",
]);

/** Lifecycle states that mean the iteration itself broke. */
const ERRORED_STATUSES = new Set<EvalIteration["status"]>([
  "failed",
  "setup_failed",
  "timed_out",
]);

/**
 * Stage reasons that mean "could not be judged", mapped to the group.
 *
 * Every reason missing here is either a pass, a plain test failure, or a
 * measurement gap, and must not be reported as an error.
 */
const ERROR_REASON_CAUSE: Partial<Record<StageReason, RunErrorCause>> = {
  connectFailed: "serverUnreachable",
  toolsListFailed: "serverUnreachable",
  toolError: "serverError",
  protocolError: "serverError",
  renderFailed: "serverError",
  evaluatorError: "settings",
  blockedByPolicy: "settings",
  providerError: "platform",
  egressUnverified: "platform",
  // The environment never came up. Who that belongs to is only in the error
  // text, so it resolves there; `unknown` is the answer if the text is silent.
  setupAborted: "unknown",
};

const ORIGIN_CAUSE: Record<ErrorOrigin, RunErrorCause | null> = {
  user_server: "serverError",
  user_config: "settings",
  mcpjam: "platform",
  ambiguous: null,
};

/** Run-side token for a pinned call whose server was not in the run. */
const NOT_CONNECTED_PATTERN = /pinned_server_not_connected|\bnot connected\b/i;

function hasPinnedToolCall(iteration: EvalIteration): boolean {
  const snapshot = iteration.testCaseSnapshot;
  if (!snapshot) return false;
  if (snapshot.caseType === "widget_probe" || snapshot.probeConfig) return true;
  const turns =
    Array.isArray(snapshot.steps) && snapshot.steps.length > 0
      ? stepsToPromptTurns(normalizeSteps(snapshot.steps))
      : (snapshot.promptTurns ?? []);
  return turns.some(isPinnedTurn);
}

/**
 * The reason the chain stopped on: the first failed stage, or — for a setup
 * abort, where nothing failed and everything is "not measured" — the first
 * row that carries a reason.
 */
function stoppingReason(chain: EvalRunDecisionChain): StageReason | null {
  if (chain.status !== "verified") return null;
  const failed = chain.stages.find((row) => row.state === "failed");
  if (failed) return failed.reason ?? null;
  const withReason = chain.stages.find(
    (row) => row.reason !== undefined && row.state !== "passed",
  );
  return withReason?.reason ?? null;
}

function causeFromText(error: string | undefined): RunErrorCause | null {
  const text = error?.trim();
  if (!text) return null;
  if (NOT_CONNECTED_PATTERN.test(text)) return "serverUnreachable";
  return ORIGIN_CAUSE[originOf(describeError(new Error(text)))];
}

/**
 * Why one iteration errored, or `null` when it did not error (it passed, is
 * still running, or failed on its merits).
 */
export function classifyIterationError(
  iteration: EvalIteration,
  chain: EvalRunDecisionChain | null,
): RunErrorCause | null {
  if (iteration.result === "passed") return null;
  if (UNFINISHED_STATUSES.has(iteration.status)) return null;

  const reason = chain ? stoppingReason(chain) : null;
  return classifyReason(iteration, reason, iteration.error);
}

function classifyReason(
  iteration: EvalIteration,
  reason: StageReason | null,
  error: string | undefined,
): RunErrorCause | null {
  const reasonCause = reason ? ERROR_REASON_CAUSE[reason] : undefined;
  const erroredByLifecycle =
    ERRORED_STATUSES.has(iteration.status) || Boolean(iteration.error?.trim());

  if (reasonCause === undefined && !erroredByLifecycle) return null;

  // A pinned call sends inputs the user wrote into the test, so a server
  // rejecting that call is first a question about those inputs.
  if (reasonCause === "serverError" && reason !== "renderFailed") {
    return hasPinnedToolCall(iteration) ? "testInput" : "serverError";
  }

  // The chain's answer is settled for everything but a setup abort and a
  // provider failure, whose owner (a spent user key vs. an outage of ours) is
  // only in the text.
  if (
    reasonCause !== undefined &&
    reasonCause !== "unknown" &&
    reasonCause !== "platform"
  ) {
    return reasonCause;
  }
  return (
    causeFromText(error) ??
    (reasonCause === "platform" ? "platform" : "unknown")
  );
}

/** Keep cause categories in a stable order. */
const CAUSE_ORDER: RunErrorCause[] = [
  "serverUnreachable",
  "serverError",
  "testInput",
  "settings",
  "platform",
  "unknown",
];

/** Only recorded messages are summarized. Older rows can fall back to their cause. */
function recordedErrors(
  iteration: EvalIteration,
): Array<{ reason: StageReason; message: string }> {
  const value = iteration.metadata?.evalErrors;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.message !== "string" ||
      typeof entry.reason !== "string" ||
      !Object.hasOwn(ERROR_REASON_CAUSE, entry.reason)
    )
      return [];
    return [{ reason: entry.reason as StageReason, message: entry.message }];
  });
}

function messageText(message: string): string {
  const redacted = redactForTelemetry(message);
  return typeof redacted === "string"
    ? redacted.trim().replace(/\s+/g, " ")
    : "";
}

export function buildRunErrorBreakdown(input: {
  iterations: readonly EvalIteration[];
  diagnostics?: readonly EvalRunDecisionDiagnostic[];
  chains?: ReadonlyMap<string, EvalRunDecisionChain>;
}): RunErrorBreakdown | null {
  const diagnostics = new Map(
    (input.diagnostics ?? []).map((item) => [item.iterationId, item]),
  );
  const finishedIds = new Set<string>();
  const erroredIds = new Set<string>();
  const groups = new Map<
    RunErrorCause,
    {
      ids: Set<string>;
      errors: Map<string, Set<string>>;
    }
  >();
  for (const iteration of input.iterations) {
    if (
      UNFINISHED_STATUSES.has(iteration.status) ||
      finishedIds.has(iteration._id)
    )
      continue;
    finishedIds.add(iteration._id);
    if (iteration.result === "passed") continue;
    const diagnostic = diagnostics.get(iteration._id);
    const chain =
      diagnostic?.chain ??
      input.chains?.get(iteration._id) ??
      chainForQuickRunIteration(iteration);
    const primary = classifyIterationError(iteration, chain);
    const entries = new Map<RunErrorCause, Set<string>>();
    const add = (cause: RunErrorCause, message: string) => {
      const messages = entries.get(cause) ?? new Set<string>();
      const text = messageText(message);
      if (text) messages.add(text);
      entries.set(cause, messages);
    };
    for (const entry of recordedErrors(iteration)) {
      const cause =
        entry.message.trim() === iteration.error?.trim() && primary
          ? primary
          : classifyReason(iteration, entry.reason, entry.message);
      if (cause) add(cause, entry.message);
    }
    if (primary) {
      const message =
        iteration.error?.trim() || diagnostic?.observed?.failure?.trim();
      if (message) add(primary, message);
      else if (!entries.has(primary)) add(primary, "");
    }
    if (!entries.size) continue;
    erroredIds.add(iteration._id);
    for (const [cause, messages] of entries) {
      const group = groups.get(cause) ?? {
        ids: new Set<string>(),
        errors: new Map<string, Set<string>>(),
      };
      group.ids.add(iteration._id);
      for (const message of messages) {
        const ids = group.errors.get(message) ?? new Set<string>();
        ids.add(iteration._id);
        group.errors.set(message, ids);
      }
      groups.set(cause, group);
    }
  }
  const finished = finishedIds.size;
  const errored = erroredIds.size;
  if (!errored) return null;
  const headline =
    errored === finished
      ? finished === 1
        ? "The only result in this run ended in an error."
        : `All ${finished} results in this run ended in an error.`
      : `${errored} of ${finished} results in this run ended in an error.`;
  return {
    errored,
    finished,
    headline,
    groups: CAUSE_ORDER.flatMap((cause) => {
      const group = groups.get(cause);
      return group
        ? [
            {
              cause,
              title: CAUSE_COPY[cause],
              count: group.ids.size,
              errors: [...group.errors].map(([message, ids]) => ({
                message,
                count: ids.size,
              })),
            },
          ]
        : [];
    }),
  };
}
