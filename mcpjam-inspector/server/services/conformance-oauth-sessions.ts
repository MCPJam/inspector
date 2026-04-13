/**
 * In-memory OAuth conformance session store.
 *
 * Each session tracks one OAuth conformance run that requires browser-based
 * authorization.  Sessions expire after 5 minutes and are cleaned up every
 * 60 seconds.
 */

import type { ConformanceResult, StepResult } from "@mcpjam/sdk";

// ── Types ───────────────────────────────────────────────────────────────

export interface OAuthConformanceSession {
  id: string;
  authorizationUrl: string;
  expectedState?: string;
  completedSteps: Array<{ step: string; status: string }>;
  /** Resolver for the interactive authorization code. */
  codeResolver?: (result: { code: string; state?: string }) => void;
  /** Rejecter for the interactive authorization code. */
  codeRejecter?: (error: Error) => void;
  /** Promise that resolves when the full conformance run completes. */
  runnerPromise?: Promise<ConformanceResult>;
  /** Final result once the run completes. */
  result?: ConformanceResult;
  /** If the run errored out. */
  error?: string;
  createdAt: number;
}

// ── Store ───────────────────────────────────────────────────────────────

const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

const sessions = new Map<string, OAuthConformanceSession>();

let cleanupTimer: ReturnType<typeof setInterval> | undefined;

function ensureCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        // Reject any pending authorization
        session.codeRejecter?.(new Error("Session expired"));
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

export function createSession(
  authorizationUrl: string,
  expectedState?: string,
): OAuthConformanceSession {
  const id = `oauth-conf-${Date.now()}-${nextId++}`;
  const session: OAuthConformanceSession = {
    id,
    authorizationUrl,
    expectedState,
    completedSteps: [],
    createdAt: Date.now(),
  };
  sessions.set(id, session);
  ensureCleanupTimer();
  return session;
}

export function getSession(
  sessionId: string,
): OAuthConformanceSession | undefined {
  return sessions.get(sessionId);
}

export function deleteSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.codeRejecter?.(new Error("Session deleted"));
    sessions.delete(sessionId);
  }
}

/**
 * Supply the authorization code from the browser callback.
 * Returns true if the session was found and the code was delivered.
 */
export function submitAuthorizationCode(
  sessionId: string,
  code: string,
  state?: string,
): boolean {
  const session = sessions.get(sessionId);
  if (!session || !session.codeResolver) return false;

  session.codeResolver({ code, state });
  session.codeResolver = undefined;
  session.codeRejecter = undefined;
  return true;
}

/**
 * Record a completed step on a session.
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
}

// For testing: clear all sessions
export function clearAllSessions(): void {
  for (const session of sessions.values()) {
    session.codeRejecter?.(new Error("Sessions cleared"));
  }
  sessions.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = undefined;
  }
}
