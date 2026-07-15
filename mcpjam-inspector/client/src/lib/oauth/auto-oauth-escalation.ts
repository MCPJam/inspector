import { toast } from "@/lib/toast";

/**
 * Session-scoped lifecycle for Auto's OAuth escalation (spec: clients SHOULD
 * limit step-up retries).
 *
 * An Auto server that 401s asks the user before redirecting into OAuth.
 * Confirming marks the attempt PENDING; the marker's one job is to survive
 * the full-page `window.location.assign` round-trip so the post-callback
 * reconnect doesn't re-prompt — if the server STILL 401s after a completed
 * flow, that's a config problem to surface, not a loop to run. Every
 * terminal outcome clears the marker explicitly:
 *
 * - `markSucceeded` — the server connected; nothing pending.
 * - `markFailed`   — the flow ended without a working connection (OAuth init
 *   failure before the redirect, post-OAuth connect failure, or surfacing
 *   the still-401 config error). Clearing here means a later MANUAL attempt
 *   re-prompts instead of being permanently muted for the session.
 *
 * Storage is sessionStorage (in-memory state dies at the redirect), keyed by
 * project + server id so identically named servers across projects don't
 * collide; the server NAME is only the last-resort key component when no id
 * exists yet.
 */
const STORAGE_KEY = "mcp-auto-oauth-escalated";

export interface AutoEscalationIdentity {
  projectId?: string | null;
  /** Hosted/Convex server id when known — preferred key component. */
  serverId?: string | null;
  serverName: string;
}

function keyOf(identity: AutoEscalationIdentity): string {
  return `${identity.projectId ?? "local"}::${
    identity.serverId ?? `name:${identity.serverName}`
  }`;
}

function readKeys(): Set<string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function writeKeys(keys: Set<string>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Storage unavailable (private mode / quota) — degrade to re-prompting.
  }
}

function remove(identity: AutoEscalationIdentity): void {
  const keys = readKeys();
  if (keys.delete(keyOf(identity))) {
    writeKeys(keys);
  }
}

export const autoOAuthEscalation = {
  /** A confirmed flow started this session and hasn't reached a terminal outcome. */
  hasPendingAttempt(identity: AutoEscalationIdentity): boolean {
    return readKeys().has(keyOf(identity));
  },
  /** The user confirmed; the interactive flow is starting (may leave the page). */
  markPending(identity: AutoEscalationIdentity): void {
    const keys = readKeys();
    keys.add(keyOf(identity));
    writeKeys(keys);
  },
  markSucceeded(identity: AutoEscalationIdentity): void {
    remove(identity);
  },
  markFailed(identity: AutoEscalationIdentity): void {
    remove(identity);
  },
};

/**
 * Confirm-before-redirect for Auto's OAuth escalation: the user picked
 * "Auto", not "OAuth", so a surprise `window.location.assign` mid-connect
 * reads as a bug. Uses the app's persistent-toast pattern (same shape as the
 * connect-failure "Open XAA Debugger" action) rather than a blocking modal.
 * Resolves exactly once; dismissal counts as "not now".
 */
export function confirmAutoOAuthEscalation(
  serverName: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    toast(`"${serverName}" requires authorization`, {
      description:
        "Continue with OAuth? You'll be redirected to the server's sign-in page.",
      duration: Infinity,
      action: {
        label: "Continue with OAuth",
        onClick: () => settle(true),
      },
      cancel: {
        label: "Not now",
        onClick: () => settle(false),
      },
      onDismiss: () => settle(false),
      onAutoClose: () => settle(false),
    });
  });
}
