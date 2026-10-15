import { logger } from "../../utils/logger.js";
import {
  parseAuthChallengeSignal,
  parseToolResultAuthChallenge,
  unwrapEraNegotiationCause,
  type AuthChallengeSignal,
} from "@mcpjam/sdk";
import { readAuthChallenge } from "../../utils/connection-effective-auth.js";
import { SetupAttribution, describeSetupFailure } from "./run-setup-signals.js";

// ── mid-run sign-in challenges ───────────────────────────────────────────────
//
// A server may let the run connect and list tools anonymously, then refuse one
// protected tool call with a sign-in challenge: an HTTP 401 (locally a thrown
// transport error; hosted, `403 UPSTREAM_AUTH_FAILED` with the challenge in its
// details), a 403 `insufficient_scope`, or a completed `isError` result
// carrying `_meta["mcp/www_authenticate"]`. An eval never signs in. The call is
// filed under the same credential tag a tokenless connect-time 401 carries, so
// the classifier above reads it as a missing credential in the environment
// (`ours`), not a server defect and not the model's doing.

/** The credential tag a challenged tool call is classified under. */
export const TOOL_AUTH_CHALLENGE_SOURCE = "authorization_required" as const;

/** Iteration metadata key: the challenged tool steps, capped. */
export const TOOL_AUTH_CHALLENGES_METADATA_KEY = "toolAuthChallenges";

export const MAX_TOOL_AUTH_CHALLENGES = 5;

export type ToolAuthChallengeFinding = {
  setupFailureSource: typeof TOOL_AUTH_CHALLENGE_SOURCE;
  attribution: SetupAttribution;
  /** As parsed: length-capped server text, to be rendered as text only. */
  authChallenge: AuthChallengeSignal;
  /** What to do about it. Evals never sign in on their own. */
  remediation: string;
  /** One redacted, capped line naming the server, the tool and the challenge. */
  line: string;
};

/** A finding, joined to the tool step it was observed on. */
export type ToolAuthChallengeRecord = ToolAuthChallengeFinding & {
  toolCallId?: string;
  toolName?: string;
  serverId?: string;
  /** The tool span the finding annotates, when there is one. */
  spanId?: string;
  promptIndex?: number;
};

/** A hosted route error carries the stamped challenge in its details. */
export function routeErrorAuthChallenge(
  error: unknown,
): AuthChallengeSignal | undefined {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current !== "object") break;
    const details = (current as { details?: unknown }).details;
    const signal =
      details && typeof details === "object"
        ? parseAuthChallengeSignal(
            (details as { authChallenge?: unknown }).authChallenge,
          )
        : undefined;
    if (signal) return signal;
    const unwrapped = unwrapEraNegotiationCause(current);
    current =
      unwrapped !== current
        ? unwrapped
        : (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The sign-in challenge a tool call carries: from the error it threw, or from
 * the result it completed with. `undefined` for anything else, including an
 * ordinary `isError` result.
 */
export function readToolAuthChallenge(outcome: {
  error?: unknown;
  result?: unknown;
}): AuthChallengeSignal | undefined {
  const signal =
    outcome.error !== undefined
      ? (readAuthChallenge(outcome.error) ??
        routeErrorAuthChallenge(outcome.error))
      : parseToolResultAuthChallenge(outcome.result);
  // Re-read through the wire narrower, so every field is capped the same way
  // whichever path produced it.
  return signal ? parseAuthChallengeSignal(signal) : undefined;
}

export function toolAuthChallengeRemediation(
  challenge: Pick<AuthChallengeSignal, "source">,
): string {
  return challenge.source === "http_403_insufficient_scope"
    ? "Reconnect this server with OAuth in the eval environment and grant the scope it asked for, then run again. Evals never sign in on their own."
    : "Connect this server with OAuth in the eval environment, then run again. Evals never sign in on their own.";
}

/**
 * Classify a mid-run tool call that hit a sign-in challenge, or return
 * `undefined` when it did not. Routed through the setup classifier with the
 * `authorization_required` tag, so attribution and the line come from the one
 * place every other credential failure is explained.
 */
export function classifyToolAuthChallenge(
  outcome: { error?: unknown; result?: unknown },
  ctx?: { serverId?: string; serverLabel?: string; toolName?: string },
): ToolAuthChallengeFinding | undefined {
  // Called from inside a tool call's own error handling: it must never be
  // the thing that throws.
  try {
    return classifyChallengedToolCall(outcome, ctx);
  } catch {
    return undefined;
  }
}

export function classifyChallengedToolCall(
  outcome: { error?: unknown; result?: unknown },
  ctx?: { serverId?: string; serverLabel?: string; toolName?: string },
): ToolAuthChallengeFinding | undefined {
  const authChallenge = readToolAuthChallenge(outcome);
  if (!authChallenge) return undefined;
  // Only the challenge's short tokens are quoted; the server's free-text
  // description stays on `authChallenge`.
  const detail = [
    authChallenge.error,
    authChallenge.requiredScope !== undefined
      ? `scope "${authChallenge.requiredScope}"`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  const tagged = Object.assign(
    new Error(
      `asked for sign-in${
        ctx?.toolName ? ` when "${ctx.toolName}" was called` : ""
      }${detail.length > 0 ? ` (${detail.join("; ")})` : ""}`,
    ),
    {
      setupFailureSource: TOOL_AUTH_CHALLENGE_SOURCE,
      ...(outcome.error !== undefined ? { cause: outcome.error } : {}),
    },
  );
  const described = describeSetupFailure(tagged, {
    ...(ctx?.serverId ? { serverId: ctx.serverId } : {}),
    ...(ctx?.serverLabel ? { serverLabel: ctx.serverLabel } : {}),
  });
  return {
    setupFailureSource: TOOL_AUTH_CHALLENGE_SOURCE,
    attribution: described.attribution,
    authChallenge,
    remediation: toolAuthChallengeRemediation(authChallenge),
    line: described.line,
  };
}

/**
 * The annotation's key on a tool step. A SYMBOL on purpose: the persisted
 * trace-span validator is closed, so a string key would fail the whole
 * iteration write; a symbol survives in-process copies (`{ ...span }`) and is
 * dropped by every serializer. What persists is the iteration metadata
 * `buildToolAuthChallengeMetadata` writes from it.
 */
export const TOOL_AUTH_CHALLENGE = Symbol.for("mcpjam.evals.toolAuthChallenge");

/** Annotate a tool step (its span, or a pinned call's tool-error record). */
export function annotateToolAuthChallenge(
  step: object,
  record: ToolAuthChallengeRecord,
): void {
  try {
    Object.defineProperty(step, TOOL_AUTH_CHALLENGE, {
      value: record,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } catch {
    // A frozen step keeps its plain error; the annotation is diagnostic only.
    logger.debug("Could not annotate a frozen tool step");
  }
}

export function toolAuthChallengeOf(
  step: unknown,
): ToolAuthChallengeRecord | undefined {
  if (!step || typeof step !== "object") return undefined;
  return (step as Record<symbol, ToolAuthChallengeRecord | undefined>)[
    TOOL_AUTH_CHALLENGE
  ];
}

/** Every challenged tool step among `steps`, one per tool call, in order. */
export function collectToolAuthChallenges(
  steps: Iterable<unknown>,
): ToolAuthChallengeRecord[] {
  const out: ToolAuthChallengeRecord[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    const record = toolAuthChallengeOf(step);
    if (!record) continue;
    const key = record.toolCallId ?? record.spanId ?? record.line;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

/**
 * `{ toolAuthChallenges }` for iteration metadata, or `{}`. Capped, because a
 * looping model can hit the same wall many times.
 */
export function buildToolAuthChallengeMetadata(
  records: readonly ToolAuthChallengeRecord[],
): Record<string, unknown> {
  return records.length > 0
    ? {
        [TOOL_AUTH_CHALLENGES_METADATA_KEY]: records
          .slice(0, MAX_TOOL_AUTH_CHALLENGES)
          .map((record) => ({ ...record })),
      }
    : {};
}
