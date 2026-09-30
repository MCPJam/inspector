/**
 * "Most of this run errored — here is whose problem each error is."
 *
 * A run where every result is an error used to show a verdict and a table of
 * red rows, and nothing that told the reader whether their server broke, their
 * test was wrong, or MCPJam failed. Users left thinking the product was broken
 * (PLB-136). This module groups the errored results by who has to act, with
 * one next step per group, so the page can say it in one place.
 *
 * ── What counts as an error ─────────────────────────────────────────────────
 *
 * An ERROR is a result that could not be judged on its merits: the server
 * returned an error, the connection failed, the model provider failed, the
 * evaluator failed. A case that ran cleanly and got the wrong answer (wrong
 * tool, wrong arguments, a failed assertion) is a FAILURE, not an error, and
 * is left out on purpose — the rest of the page already explains those.
 *
 * ── Where the cause comes from ──────────────────────────────────────────────
 *
 * The iteration's stage chain first: its reasons are the contract's own
 * classification and need no guessing. Only when the chain says nothing do we
 * read the recorded error text, through the same `describeError` origin table
 * every other error surface uses. Anything still unsettled lands in `unknown`
 * rather than being assigned to someone.
 */
import { describeError, originOf, type ErrorOrigin } from "@mcpjam/sdk/browser";
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

/** Why a result errored, grouped by who has to act on it. */
export type RunErrorCause =
  | "serverUnreachable"
  | "serverError"
  | "testInput"
  | "settings"
  | "platform"
  | "unknown";

/** Who the reader should look at. Not blame: the next place to go. */
export type RunErrorOwner = "yourServer" | "yourTest" | "mcpjam" | "unclear";

export type RunErrorGroup = {
  cause: RunErrorCause;
  owner: RunErrorOwner;
  title: string;
  nextStep: string;
  count: number;
  /** One errored iteration to open as an example. */
  exampleIterationId: string;
};

export type RunErrorBreakdown = {
  errored: number;
  /** Results that finished, errored or not. The denominator of the headline. */
  finished: number;
  headline: string;
  groups: RunErrorGroup[];
};

const CAUSE_COPY: Record<
  RunErrorCause,
  { owner: RunErrorOwner; title: string; nextStep: string }
> = {
  serverUnreachable: {
    owner: "yourServer",
    title: "MCPJam couldn't connect to your MCP server",
    nextStep:
      "Open Servers, reconnect the server this suite uses, then run it again.",
  },
  serverError: {
    owner: "yourServer",
    title: "Your MCP server returned an error",
    nextStep:
      "Open a result to read the error your server sent back. The fix is usually in the tool's code or its input schema.",
  },
  testInput: {
    owner: "yourTest",
    title: "Your server rejected the tool inputs saved in the test",
    nextStep:
      "Edit the test and check the tool call's inputs. Required fields may be missing or in the wrong shape. If the inputs are right, the problem is in your server.",
  },
  settings: {
    owner: "yourTest",
    title: "A test or workspace setting stopped the run",
    nextStep:
      "Open a result to see which setting. Common causes are a model key or credit limit, a tool policy, or the grader setup.",
  },
  platform: {
    owner: "mcpjam",
    title: "MCPJam or the AI model provider failed",
    nextStep:
      "This isn't your server. Run the suite again. If it keeps happening, let us know.",
  },
  unknown: {
    owner: "unclear",
    title: "The cause wasn't recorded",
    nextStep: "Open a result to see the full error.",
  },
};

/** Show the breakdown only when errors are most of the run, not a stray one. */
const MIN_ERRORED_SHARE = 0.5;

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
    causeFromText(iteration.error) ??
    (reasonCause === "platform" ? "platform" : "unknown")
  );
}

/** Order groups by who acts, so the reader's own fixes come first. */
const CAUSE_ORDER: RunErrorCause[] = [
  "serverUnreachable",
  "serverError",
  "testInput",
  "settings",
  "platform",
  "unknown",
];

/**
 * The breakdown for a run, or `null` when errors are not most of it.
 *
 * `diagnostics` and `chains` are the page's existing reads; either may be
 * partial. An iteration neither covers falls back to its own stored metadata,
 * and finally to its error text.
 */
export function buildRunErrorBreakdown(input: {
  iterations: readonly EvalIteration[];
  diagnostics?: readonly EvalRunDecisionDiagnostic[];
  chains?: ReadonlyMap<string, EvalRunDecisionChain>;
}): RunErrorBreakdown | null {
  const diagnosticChains = new Map(
    (input.diagnostics ?? []).map((item) => [item.iterationId, item.chain]),
  );

  let finished = 0;
  const groups = new Map<RunErrorCause, RunErrorGroup>();
  for (const iteration of input.iterations) {
    if (UNFINISHED_STATUSES.has(iteration.status)) continue;
    finished += 1;
    if (iteration.result === "passed") continue;

    const chain =
      diagnosticChains.get(iteration._id) ??
      input.chains?.get(iteration._id) ??
      chainForQuickRunIteration(iteration);
    const cause = classifyIterationError(iteration, chain);
    if (!cause) continue;

    const existing = groups.get(cause);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(cause, {
        cause,
        ...CAUSE_COPY[cause],
        count: 1,
        exampleIterationId: iteration._id,
      });
    }
  }

  const errored = [...groups.values()].reduce(
    (sum, group) => sum + group.count,
    0,
  );
  if (finished === 0 || errored === 0) return null;
  if (errored / finished < MIN_ERRORED_SHARE) return null;

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
    groups: CAUSE_ORDER.flatMap((cause) => groups.get(cause) ?? []),
  };
}
