/**
 * Grading for the step-up probe: a protected tool, called with a token that
 * lacks its scope, must answer with the challenge Claude re-authorizes on.
 *
 * Kept apart from the probe for the same reason as the other intrusive
 * grades: evidence captured elsewhere can be graded without calling the tool
 * again.
 *
 * Pure data. No transport.
 */

import {
  parseBearerAuthenticateParameters,
  parseInsufficientScopeChallenge,
} from "../oauth/state-machines/shared/challenges.js";
import { claudePolicySource } from "./manifest.js";
import type { ClaudeReadinessFinding } from "./types.js";
import {
  notEvaluated,
  satisfied,
  violated,
  type ClaudeCheckDefinition,
  type ClaudeCheckStamp,
} from "./checks/helpers.js";

export const STEP_UP: ClaudeCheckDefinition = {
  id: "claude.intrusive.step-up-challenge",
  title: "A protected tool challenges for the scopes it needs",
  lane: "runtime-compatibility",
  class: "required",
  source: claudePolicySource("authentication", "§Step-up authorization"),
  provenance: "wire",
  intrusiveness: "side-effecting",
  requiresCapabilities: ["intrusive-probes"],
};

/** What the step-up probe saw. */
export interface ClaudeStepUpObservation {
  attempted: boolean;
  toolName: string;
  status: number;
  wwwAuthenticate?: string;
  error?: string;
  /**
   * How a 2xx answer refused the call: a JSON-RPC error, or a result with
   * `isError`. A refusal is not a success, whatever the HTTP status.
   */
  refusal?: "rpc-error" | "tool-error";
  /** The refusal reports invalid arguments (the probe sends none). */
  invalidArguments?: true;
}

/** What the run declared about the one tool the probe may call. */
export interface ClaudeStepUpTarget {
  protectedToolName?: string;
  expectedScopes?: string[];
}

const RE_AUTHORIZE =
  'Claude needs a 403 with `error="insufficient_scope"` to know it should re-authorize rather than give up.';

/**
 * The scopes a step-up challenge asked for, beside the ones the run expected.
 *
 * Reported, never graded. A challenge that names no `scope` is conforming, and
 * a server is free to ask for scopes the operator did not list — so the useful
 * output is the comparison itself, which tells whoever reads the report
 * whether their declared expectation matched reality.
 */
function summarizeStepUpScopes(
  wwwAuthenticate: string | undefined,
  expectedScopes: string[] | undefined
): Record<string, unknown> {
  const expected = expectedScopes ?? [];
  const challengedScopes = wwwAuthenticate
    ? (parseBearerAuthenticateParameters(wwwAuthenticate).scope ?? "")
        .split(/\s+/)
        .filter(Boolean)
    : [];
  return {
    expectedScopes: expected,
    challengedScopes,
    // `undefined` rather than a boolean when the challenge named nothing:
    // there is no overlap to report, and `false` would read as a mismatch the
    // server never committed.
    scopesOverlapExpectation:
      challengedScopes.length === 0
        ? undefined
        : challengedScopes.some((scope) => expected.includes(scope)),
  };
}

/** A 2xx answer: never the challenge, but not always the server's fault. */
function gradeSuccessStatus(
  target: ClaudeStepUpTarget,
  stepUp: ClaudeStepUpObservation,
  stamp: ClaudeCheckStamp
): ClaudeReadinessFinding {
  const tool = `\`${stepUp.toolName}\``;
  if (stepUp.invalidArguments) {
    // The arguments were refused before any sign-in decision, so the server
    // was never asked the question this check grades.
    return notEvaluated(
      STEP_UP,
      stamp,
      `${tool} rejected the call's arguments (the probe sends none) before deciding on sign-in, so the step-up was not tested`,
      { status: stepUp.status }
    );
  }
  if (stepUp.refusal) {
    // The server did refuse, but in a form Claude cannot act on.
    const how =
      stepUp.refusal === "rpc-error"
        ? "a JSON-RPC error"
        : "a tool error result";
    return violated(
      STEP_UP,
      stamp,
      `Calling ${tool} without its scopes answered ${stepUp.status} with ${how}. ${RE_AUTHORIZE}`,
      {
        status: stepUp.status,
        refusal: stepUp.refusal,
        ...summarizeStepUpScopes(undefined, target.expectedScopes),
      }
    );
  }
  if (stepUp.error) {
    return notEvaluated(
      STEP_UP,
      stamp,
      `${tool} answered ${stepUp.status}, but ${stepUp.error}, so the step-up was not tested`,
      { status: stepUp.status }
    );
  }
  // THE TOKEN ALREADY HELD THE SCOPE, or the tool needs none. Either way the
  // server was never asked the question this check grades, and failing it
  // would accuse a submitter of a probe misconfiguration.
  return notEvaluated(
    STEP_UP,
    stamp,
    `${tool} succeeded with the supplied token, so no step-up was needed; supply a token that lacks the tool's scope`,
    {
      status: stepUp.status,
      ...summarizeStepUpScopes(undefined, target.expectedScopes),
    }
  );
}

export function gradeStepUp(
  target: ClaudeStepUpTarget,
  stepUp: ClaudeStepUpObservation | undefined,
  stamp: ClaudeCheckStamp
): ClaudeReadinessFinding {
  if (!target.protectedToolName) {
    return notEvaluated(
      STEP_UP,
      stamp,
      "no `protectedToolName` was declared; calling an arbitrary tool to see what happens is not something this runner does",
      { missingInput: "intrusive.protectedToolName" }
    );
  }
  if (!stepUp?.attempted) {
    return notEvaluated(
      STEP_UP,
      stamp,
      stepUp?.error ?? "the step-up probe did not run"
    );
  }
  if (stepUp.status >= 200 && stepUp.status < 300) {
    return gradeSuccessStatus(target, stepUp, stamp);
  }

  const challenged =
    stepUp.status === 403 &&
    parseInsufficientScopeChallenge(stepUp.wwwAuthenticate).isInsufficientScope;
  // WHAT THE CONFIG PROMISED, MEASURED. `expectedScopes` is required
  // alongside `protectedToolName` so the run states what it is asserting,
  // but nothing compared it, so the requirement bought a config error and no
  // evidence. Recorded rather than graded: the `scope` parameter is OPTIONAL
  // on an `insufficient_scope` challenge — Claude selects scopes from
  // discovery when it is absent — so a server that omits it, or names its
  // own, is not thereby wrong.
  const scopeEvidence = summarizeStepUpScopes(
    stepUp.wwwAuthenticate,
    target.expectedScopes
  );
  return challenged
    ? satisfied(STEP_UP, stamp, {
        toolName: stepUp.toolName,
        wwwAuthenticate: stepUp.wwwAuthenticate,
        ...scopeEvidence,
      })
    : violated(
        STEP_UP,
        stamp,
        `Calling \`${stepUp.toolName}\` without its scopes answered ${stepUp.status}. ${RE_AUTHORIZE}`,
        {
          status: stepUp.status,
          wwwAuthenticate: stepUp.wwwAuthenticate,
          ...scopeEvidence,
        }
      );
}
