/**
 * In-memory OAuth conformance session store.
 *
 * Each session wraps one {@link RemoteBrowserAuthorizationController} from the
 * SDK — the controller owns the "wait for auth URL / deliver code" dance, this
 * store owns the `sessionId → controller` mapping and TTL eviction.
 *
 * A session waits up to 10 minutes for the user to finish authorizing, and is
 * dropped after 15 minutes without activity (creation, the code arriving, or a
 * client poll). The sweep runs every 60 seconds.
 */

import {
  createRemoteBrowserAuthorizationController,
  type ConformanceResult,
  type RemoteBrowserAuthorizationController,
} from "@mcpjam/sdk";

// ── Types ───────────────────────────────────────────────────────────────

export interface OAuthConformanceSession {
  id: string;
  controller: RemoteBrowserAuthorizationController;
  /** Authorization URL once the runner has surfaced it. */
  authorizationUrl?: string;
  completedSteps: Array<{ step: string; status: string }>;
  /** Promise that resolves when the full conformance run completes. */
  runnerPromise?: Promise<ConformanceResult>;
  /** Final result once the run completes. */
  result?: ConformanceResult;
  /** If the run errored out. */
  error?: string;
  createdAt: number;
  /** Last time the browser or a poll touched this session; drives expiry. */
  lastActivityAt: number;
}

// ── Store ───────────────────────────────────────────────────────────────

/**
 * How long the runner waits for the user to come back from the authorization
 * server. A consent screen with a login, MFA or an account picker easily takes
 * longer than the runner's 30s per-step timeout, which used to cap this wait.
 */
export const AUTHORIZATION_WAIT_MS = 10 * 60 * 1000; // 10 minutes
// Longer than the wait, so a session still waiting on consent (no polls yet:
// the client only polls once the code is back) is never swept first.
const SESSION_IDLE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

const sessions = new Map<string, OAuthConformanceSession>();

let cleanupTimer: ReturnType<typeof setInterval> | undefined;

function ensureCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivityAt > SESSION_IDLE_TTL_MS) {
        session.controller.fail(new Error("Session expired"));
        sessions.delete(id);
      }
    }
    if (sessions.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = undefined;
    }
  }, CLEANUP_INTERVAL_MS);
  // Don't prevent process exit
  if (
    cleanupTimer &&
    typeof cleanupTimer === "object" &&
    "unref" in cleanupTimer
  ) {
    cleanupTimer.unref();
  }
}

// ── Public API ──────────────────────────────────────────────────────────

let nextId = 1;

export interface CreateSessionOptions {
  /**
   * Public URL that the authorization server will redirect back to. For local
   * mode this is the inspector's own `http://127.0.0.1:PORT/oauth/callback/debug`;
   * for hosted mode it's whatever the client-side callback origin reports.
   */
  redirectUrl: string;
  /**
   * How long to wait for an authorization code after the URL is surfaced.
   * Defaults to {@link AUTHORIZATION_WAIT_MS}.
   */
  codeTimeoutMs?: number;
}

export function createSession(
  options: CreateSessionOptions,
): OAuthConformanceSession {
  const id = `oauth-conf-${Date.now()}-${nextId++}`;
  const controller = createRemoteBrowserAuthorizationController({
    redirectUrl: options.redirectUrl,
    codeTimeoutMs: options.codeTimeoutMs ?? AUTHORIZATION_WAIT_MS,
  });
  const now = Date.now();
  const session: OAuthConformanceSession = {
    id,
    controller,
    completedSteps: [],
    createdAt: now,
    lastActivityAt: now,
  };

  // Once the runner surfaces the auth URL, mirror it onto the session so the
  // `/oauth/start` handler can return it without re-awaiting the promise.
  void controller.awaitAuthorizationUrl
    .then(({ authorizationUrl }) => {
      session.authorizationUrl = authorizationUrl;
    })
    .catch(() => {
      /* fail() already recorded on session.error via setSessionError */
    });

  sessions.set(id, session);
  ensureCleanupTimer();
  return session;
}

export function getSession(
  sessionId: string,
): OAuthConformanceSession | undefined {
  return sessions.get(sessionId);
}

/** Keep a session alive while a client is still polling it. */
export function touchSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) session.lastActivityAt = Date.now();
}

export function deleteSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.controller.fail(new Error("Session deleted"));
    sessions.delete(sessionId);
  }
}

/**
 * Supply the authorization code from the browser callback. Returns `true` when
 * the session exists and was still waiting for a code, `false` otherwise.
 */
export function submitAuthorizationCode(
  sessionId: string,
  code: string,
  state?: string,
): boolean {
  const session = sessions.get(sessionId);
  // No way to ask the SDK controller "are you waiting?" directly, so we rely
  // on the runner's own state-mismatch handling and treat any unknown session
  // as a miss. A result before the code means the authorization wait ran out.
  if (!session || session.result) return false;
  session.lastActivityAt = Date.now();
  session.controller.deliverCode({ code, state });
  return true;
}

/**
 * Record a completed step on a session. Used for progress reporting.
 */
export function addCompletedStep(
  sessionId: string,
  step: string,
  status: string,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.completedSteps.push({ step, status });
}

/**
 * Store the final result on a session.
 */
export function setSessionResult(
  sessionId: string,
  result: ConformanceResult,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.result = result;
}

/**
 * Store an error on a session.
 */
export function setSessionError(sessionId: string, error: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.error = error;
  session.controller.fail(new Error(error));
}

// For testing: clear all sessions
export function clearAllSessions(): void {
  for (const session of sessions.values()) {
    session.controller.fail(new Error("Sessions cleared"));
  }
  sessions.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = undefined;
  }
}
