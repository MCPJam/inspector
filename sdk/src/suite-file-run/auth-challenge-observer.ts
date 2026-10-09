/**
 * The local run's sign-in observer.
 *
 * A server may accept an anonymous connection and refuse one protected tool
 * call with a sign-in challenge: an HTTP 401 with `WWW-Authenticate`, a 403
 * `insufficient_scope`, or an `isError` result carrying
 * `_meta["mcp/www_authenticate"]`. An interactive host would offer sign-in. A
 * local run never does: it records the challenge against the iteration as
 * `authorization_required`, so the report names the server that needs a
 * credential instead of passing the refusal off as an ordinary tool failure.
 *
 * Observation only. The call's result or error reaches the model unchanged,
 * and nothing here starts OAuth or retries.
 *
 * One observer per ITERATION, like the policy gate: a challenge is iteration
 * evidence, and a shared observer would attribute one iteration's refusal to
 * another.
 */

import type { ToolSet } from "ai";
import {
  parseToolResultAuthChallenge,
  type AuthChallengeSignal,
} from "../mcp-client-manager/auth-challenge.js";
import { extractAuthChallenge } from "../mcp-client-manager/errors.js";
import type { SuiteFileAuthRequired } from "./types.js";

export type LocalAuthChallengeObserver = {
  /** The iteration's classification, or `undefined` when no call was challenged. */
  authRequired: () => SuiteFileAuthRequired | undefined;
  wrap: (tools: ToolSet) => ToolSet;
};

/** The parsed fields a report keeps; the raw header stays out of it. */
function reportedChallenge(
  challenge: AuthChallengeSignal
): SuiteFileAuthRequired["challenge"] {
  return {
    source: challenge.source,
    ...(challenge.error !== undefined ? { error: challenge.error } : {}),
    ...(challenge.errorDescription !== undefined
      ? { errorDescription: challenge.errorDescription }
      : {}),
    ...(challenge.requiredScope !== undefined
      ? { requiredScope: challenge.requiredScope }
      : {}),
    ...(challenge.resourceMetadataUrl !== undefined
      ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
      : {}),
    facets: { ...challenge.facets },
  };
}

export function createLocalAuthChallengeObserver(args: {
  /** The target server that owns a tool, by tool name. */
  serverOf: (toolName: string) => string | undefined;
}): LocalAuthChallengeObserver {
  let first:
    | Omit<SuiteFileAuthRequired, "challengedCalls">
    | undefined;
  let challengedCalls = 0;
  const record = (
    toolName: string,
    toolCallId: string | undefined,
    challenge: AuthChallengeSignal
  ) => {
    challengedCalls += 1;
    if (first) return;
    const server = args.serverOf(toolName);
    first = {
      classification: "authorization_required",
      ...(server !== undefined ? { server } : {}),
      toolName,
      ...(toolCallId ? { toolCallId } : {}),
      challenge: reportedChallenge(challenge),
    };
  };
  return {
    authRequired: () => (first ? { ...first, challengedCalls } : undefined),
    wrap(tools) {
      const wrapped: ToolSet = { ...tools };
      for (const [toolName, tool] of Object.entries(tools)) {
        const execute = tool.execute;
        if (typeof execute !== "function") continue;
        wrapped[toolName] = {
          ...tool,
          execute: async (input: unknown, options: unknown) => {
            const toolCallId = (options as { toolCallId?: unknown } | undefined)
              ?.toolCallId;
            const id = typeof toolCallId === "string" ? toolCallId : undefined;
            let result: unknown;
            try {
              result = await (
                execute as (input: unknown, options: unknown) => unknown
              )(input, options);
            } catch (error) {
              const challenge = extractAuthChallenge(error);
              if (challenge) record(toolName, id, challenge);
              throw error;
            }
            const challenge = parseToolResultAuthChallenge(result);
            if (challenge) record(toolName, id, challenge);
            return result;
          },
        } as ToolSet[string];
      }
      return wrapped;
    },
  };
}
