/**
 * Mid-session sign-in for one call: the per-call ledger, the gate on the
 * server's auth method, and `applyToolCallAuthChallenge`, which starts OAuth
 * after a Connect click. Re-exported from `oauth-orchestrator`.
 */
import { resolveStoredIssuer } from "@/lib/oauth/mcp-oauth";
import type { ServerWithName } from "./app-types";
import type { OAuthTrace } from "@/lib/oauth/oauth-trace";
import type { BuiltOAuthRequest } from "@/lib/oauth/oauth-request";
import type { AuthChallengeSignal } from "@mcpjam/sdk/browser";
import { stepUpScopeUnion } from "@/lib/oauth/requested-scopes";
import {
  canonicalizeStepUpResourceUrl,
  normalizeStepUpOperationKey,
  SCOPE_STEP_UP_LIVE_TTL_MS,
  type StepUpOperationKey,
} from "@/shared/scope-step-up";
import {
  ensureAuthorizedForReconnect,
  flowDigestHook,
  parseOAuthScopes,
  readOriginalOAuthScopes,
  readServerUrlForStepUp,
  stepUpAttemptsStore,
  validResourceMetadataUrlHint,
  type OAuthResult,
  type ToolCallStepUpOperation,
} from "./oauth-orchestrator";

// ===========================================================================
// Mid-session sign-in ("lazy authentication")
// ===========================================================================
//
// A server that let the client connect anonymously refuses one protected call
// with a sign-in challenge (an HTTP 401, or a `_meta` challenge on a tool
// result). This is step-up starting from an empty scope set, plus three things
// step-up does not need:
//
//   1. CONSENT before the first redirect. Presenting the challenge has no side
//      effects; only an explicit Connect click (`confirmed: true`) writes the
//      ledger and starts OAuth.
//   2. A GATE on the server-stamped effective auth method. Only a tokenless
//      Auto server (`discover`) or an OAuth server may start sign-in; `none`,
//      `bearer` and `xaa` get a hint. The browser never computes the method.
//   3. TOKENS KEPT until the callback succeeds, so abandoning Connect does not
//      break every other tool on an already-authorized server.

const AUTH_CHALLENGE_LEDGER_PREFIX = "mcp-auth-challenge-ledger-v2-";

/**
 * One sign-in attempt per operation per live window.
 *
 * - `awaiting_callback`: a Connect click redirected and no callback has come
 *   back. Seeing that on a NEW click means the user came back with the Back
 *   button; the entry is cleared and the click retries.
 * - `signed_in`: a callback completed for this server since the click. A
 *   challenge now is a repeat after sign-in, and is permanent for this window.
 */
export interface AuthChallengeAttempt {
  projectId: string;
  serverId: string;
  surface: string;
  callId: string;
  chatSessionId?: string;
}
function hasAuthAttemptIdentity(value: unknown): value is AuthChallengeAttempt {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Partial<AuthChallengeAttempt>;
  return [
    attempt.projectId,
    attempt.serverId,
    attempt.surface,
    attempt.callId,
  ].every((value) => typeof value === "string" && value.length > 0);
}
type AuthChallengeOperation = StepUpOperationKey & {
  attempt: AuthChallengeAttempt;
};

type AuthChallengeLedgerEntry = {
  serverName: string;
  operation: AuthChallengeOperation;
  phase: "awaiting_callback" | "signed_in";
  /**
   * A digest of the authorization request's `state`, once the redirect
   * started (never the state itself; see `authorizationFlowDigest`).
   */
  flowDigest?: string;
  expiresAt: number;
};

function authChallengeLedgerKey(operation: AuthChallengeOperation): string {
  return `${AUTH_CHALLENGE_LEDGER_PREFIX}${encodeURIComponent(
    JSON.stringify([normalizeStepUpOperationKey(operation), operation.attempt]),
  )}`;
}

function readAuthChallengeLedger(
  operation: AuthChallengeOperation,
): AuthChallengeLedgerEntry | undefined {
  try {
    const store = stepUpAttemptsStore();
    const key = authChallengeLedgerKey(operation);
    const raw = store?.getItem(key);
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as Partial<AuthChallengeLedgerEntry>;
    if (
      typeof entry.serverName !== "string" ||
      (entry.phase !== "awaiting_callback" && entry.phase !== "signed_in") ||
      typeof entry.expiresAt !== "number" ||
      !hasAuthAttemptIdentity(entry.operation?.attempt) ||
      entry.expiresAt <= Date.now()
    ) {
      store?.removeItem(key);
      return undefined;
    }
    return entry as AuthChallengeLedgerEntry;
  } catch {
    return undefined;
  }
}

/** False when the entry did not persist, so the caller can stop the sign-in. */
function writeAuthChallengeLedger(entry: AuthChallengeLedgerEntry): boolean {
  const key = authChallengeLedgerKey(entry.operation);
  const raw = JSON.stringify(entry);
  try {
    const store = stepUpAttemptsStore();
    if (!store) return false;
    store.setItem(key, raw);
    return store.getItem(key) === raw;
  } catch {
    return false;
  }
}

/** Without its ledger entry a repeat challenge after sign-in would prompt again. */
const AUTH_CHALLENGE_SAVE_FAILED_MESSAGE =
  "MCPJam couldn’t save this sign-in. Please try again.";

function clearAuthChallengeLedger(operation: AuthChallengeOperation): void {
  try {
    stepUpAttemptsStore()?.removeItem(authChallengeLedgerKey(operation));
  } catch {
    // Best-effort.
  }
}

function authChallengeOperationKey(
  server: ServerWithName,
  operation: ToolCallStepUpOperation,
  attempt: AuthChallengeAttempt,
): AuthChallengeOperation {
  return {
    attempt,
    resourceUrl: canonicalizeStepUpResourceUrl(
      readServerUrlForStepUp(server) ?? "",
    ),
    method: operation.method,
    operation: operation.operation,
  };
}

function forEachAuthChallengeLedgerEntry(
  visit: (entry: AuthChallengeLedgerEntry, key: string, store: Storage) => void,
): void {
  const store = stepUpAttemptsStore();
  if (!store) return;
  for (let index = store.length - 1; index >= 0; index -= 1) {
    const key = store.key(index);
    if (!key?.startsWith(AUTH_CHALLENGE_LEDGER_PREFIX)) continue;
    const raw = store.getItem(key);
    if (!raw) continue;
    let entry: AuthChallengeLedgerEntry;
    try {
      entry = JSON.parse(raw) as AuthChallengeLedgerEntry;
    } catch {
      store.removeItem(key);
      continue;
    }
    if (
      !hasAuthAttemptIdentity(entry.operation?.attempt) ||
      typeof entry.expiresAt !== "number" ||
      entry.expiresAt <= Date.now()
    ) {
      store.removeItem(key);
      continue;
    }
    visit(entry, key, store);
  }
}

/**
 * A completed OAuth callback for `serverName`. Every attempt awaiting it moves
 * to `signed_in`, so a repeat challenge on the same call is permanent.
 * Returns how many attempts it completed.
 *
 * Only the attempt with the exact callback digest completes. Missing or
 * legacy flow identity cannot authorize a retry.
 */
export function markAuthChallengeSignedIn(
  serverName: string,
  callbackDigest?: string,
): number {
  let completed = 0;
  try {
    if (!callbackDigest) return 0;
    forEachAuthChallengeLedgerEntry((entry, key, store) => {
      if (
        entry.serverName !== serverName ||
        entry.phase !== "awaiting_callback"
      ) {
        return;
      }
      if (!entry.flowDigest || entry.flowDigest !== callbackDigest) {
        return;
      }
      store.setItem(key, JSON.stringify({ ...entry, phase: "signed_in" }));
      completed += 1;
    });
  } catch {
    // Best-effort.
  }
  return completed;
}

/** Whether a sign-in for `serverName` redirected and has not come back. */
export function hasAuthChallengeAwaitingCallback(serverName: string): boolean {
  let awaiting = false;
  try {
    forEachAuthChallengeLedgerEntry((entry) => {
      if (
        entry.serverName === serverName &&
        entry.phase === "awaiting_callback"
      ) {
        awaiting = true;
      }
    });
  } catch {
    // Best-effort.
  }
  return awaiting;
}

/** Forget a server's attempts after a SUCCESSFUL protected call. */
export function resetAuthChallenge(
  server: ServerWithName,
  operation: ToolCallStepUpOperation,
  attempt: AuthChallengeAttempt,
): void {
  clearAuthChallengeLedger(
    authChallengeOperationKey(server, operation, attempt),
  );
}

export type AuthChallengeGate =
  | { kind: "allowed" }
  | {
      kind: "blocked";
      reason: "none" | "bearer" | "xaa" | "unknown";
      hint: string;
    };

/**
 * May this challenge start an interactive sign-in at all? Read from the
 * server-stamped effective auth method, never from a browser-side parse.
 */
export function gateAuthChallenge(
  effectiveAuth: AuthChallengeSignal["effectiveAuth"],
): AuthChallengeGate {
  switch (effectiveAuth) {
    case "discover":
    case "oauth":
      return { kind: "allowed" };
    case "none":
      return {
        kind: "blocked",
        reason: "none",
        hint: "This server asked for sign-in, but its authentication is set to None. Switch it to Auto or OAuth to sign in.",
      };
    case "bearer":
      return {
        kind: "blocked",
        reason: "bearer",
        hint: "This server rejected the static credential it was given. Update the server's bearer token or headers.",
      };
    case "xaa":
      return {
        kind: "blocked",
        reason: "xaa",
        hint: "Interactive sign-in is not available for this server. Check the server's Cross-App Access (XAA) settings.",
      };
    default:
      return {
        kind: "blocked",
        reason: "unknown",
        hint: "Could not start sign-in. Reconnect the server and try again.",
      };
  }
}

export type AuthChallengeOutcome =
  | ({ kind: "blocked" } & Extract<AuthChallengeGate, { kind: "blocked" }>)
  /** Presented, not acted on: render the Connect card. No side effects. */
  | { kind: "pendingConnect" }
  /** A repeat challenge after sign-in. Permanent for this window. */
  | { kind: "permanent" }
  | {
      kind: "started";
      reauthorization: OAuthResult;
      /** The scopes requested, or `undefined` when discovery decides. */
      scopes?: string[];
    };

/**
 * Handle a mid-session sign-in challenge on one operation.
 *
 * Without `confirmed: true` this has NO side effects: it gates and reports
 * whether a Connect card applies. A confirmed click writes the one-attempt
 * ledger and starts OAuth; the caller saves anything it will replay BEFORE
 * calling, and binds it to the flow through `onAuthorizationFlow`.
 */
export async function applyToolCallAuthChallenge(
  server: ServerWithName,
  signal: AuthChallengeSignal,
  options: {
    operation: ToolCallStepUpOperation;
    /**
     * The call this challenge belongs to. The ledger is keyed by it, so the
     * flow digest and a repeat after sign-in are recorded per call.
     */
    attempt: AuthChallengeAttempt;
    confirmed: boolean;
    beforeRedirect?: (oauthOptions: BuiltOAuthRequest) => void;
    /** Told the digest of the flow's `state`; see `authorizationFlowDigest`. */
    onAuthorizationFlow?: (flow: { digest: string }) => void;
    onTraceUpdate?: (trace: OAuthTrace) => void;
    /**
     * The server already has a grant the browser cannot see: a hosted
     * credential. Its scopes are kept, exactly as for browser tokens.
     */
    existingGrant?: boolean;
  },
): Promise<AuthChallengeOutcome> {
  const gate = gateAuthChallenge(signal.effectiveAuth);
  if (gate.kind === "blocked") return gate;

  const operationKey = authChallengeOperationKey(
    server,
    options.operation,
    options.attempt,
  );
  const ledger = readAuthChallengeLedger(operationKey);
  if (ledger?.phase === "signed_in") return { kind: "permanent" };
  if (!options.confirmed) return { kind: "pendingConnect" };

  // A click that finds an attempt still awaiting its callback: the user came
  // back with the Back button. The old attempt can never complete, so it is
  // cleared and this click retries instead of being refused for the window.
  if (ledger?.phase === "awaiting_callback") {
    clearAuthChallengeLedger(operationKey);
  }

  // Scopes: the challenge's `scope` when it named one, unioned with what
  // this server's existing grant requested; otherwise nothing, and discovery
  // decides. Never widen a first sign-in by guessing.
  const serverUrl = readServerUrlForStepUp(server);
  const issuer = resolveStoredIssuer(server.name, serverUrl);
  const challengedScopes = parseOAuthScopes(signal.requiredScope);
  const hasExistingGrant =
    Boolean(server.oauthTokens) || options.existingGrant === true;
  const scopes = challengedScopes
    ? hasExistingGrant
      ? stepUpScopeUnion(
          server.name,
          issuer,
          challengedScopes,
          readOriginalOAuthScopes(server),
        )
      : challengedScopes
    : undefined;

  if (
    !writeAuthChallengeLedger({
      serverName: server.name,
      operation: {
        ...normalizeStepUpOperationKey(operationKey),
        attempt: options.attempt,
      },
      phase: "awaiting_callback",
      expiresAt: Date.now() + SCOPE_STEP_UP_LIVE_TTL_MS,
    })
  )
    throw new Error(AUTH_CHALLENGE_SAVE_FAILED_MESSAGE);

  let reauthorization: OAuthResult;
  try {
    reauthorization = await ensureAuthorizedForReconnect(server, {
      allowInteractiveOAuthFlow: true,
      interactiveOAuthConfirmed: true,
      forceInteractiveFlow: true,
      preserveExistingAuthorization: true,
      ...(scopes ? { stepUpScopes: scopes } : {}),
      resourceMetadataUrl: validResourceMetadataUrlHint(
        signal.resourceMetadataUrl,
      ),
      onTraceUpdate: options.onTraceUpdate,
      beforeRedirect: options.beforeRedirect,
      onAuthorizationRedirect: flowDigestHook((flow) => {
        const current = readAuthChallengeLedger(operationKey);
        // Thrown here, the redirect does not start.
        if (
          current?.phase === "awaiting_callback" &&
          !writeAuthChallengeLedger({ ...current, flowDigest: flow.digest })
        )
          throw new Error(AUTH_CHALLENGE_SAVE_FAILED_MESSAGE);
        options.onAuthorizationFlow?.(flow);
      }),
    });
  } catch (error) {
    clearAuthChallengeLedger(operationKey);
    throw error;
  }
  // Nothing navigated and nothing was granted: the click is not spent.
  if (
    reauthorization.kind === "error" ||
    reauthorization.kind === "reauth_required"
  ) {
    clearAuthChallengeLedger(operationKey);
  }
  return { kind: "started", reauthorization, scopes };
}
