import { create } from "zustand";

/**
 * Session-scoped lifecycle for Auto's OAuth escalation (spec: clients SHOULD
 * limit step-up retries).
 *
 * An Auto server that 401s asks the user before redirecting into OAuth.
 * Confirming marks the attempt PENDING; if the server STILL 401s while it is
 * pending, that's a config problem to surface, not a loop to run. Every
 * terminal outcome clears the marker explicitly:
 *
 * - `markSucceeded` — the server connected; nothing pending.
 * - `markFailed`   — the flow ended without a working connection (OAuth init
 *   failure before the redirect, post-OAuth connect failure, or surfacing
 *   the still-401 config error). Clearing here means a later MANUAL attempt
 *   re-prompts instead of being permanently muted for the session.
 *
 * Storage is sessionStorage, keyed by project + server id; the server NAME is
 * only the last-resort key component when no id exists yet. The server id is
 * what keeps identically named servers apart: in hosted mode every Convex
 * project shares the page's one local project id.
 *
 * The project component is the local project id, which is regenerated on
 * every page load, so a marker does not outlive the full-page OAuth redirect.
 * Keep it that way unless the guard can tell a completed flow from an
 * abandoned one: after a redirect the OAuth callback reports its own outcome,
 * and a surviving marker turned Back-from-the-provider into a false "still
 * returns 401 after OAuth" (PLB-284). Every escalation is user-confirmed, so
 * no retry loop is possible without it.
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

interface AuthorizationPrompt {
  id: number;
  serverName: string;
  resolve: (confirmed: boolean) => void;
}

interface AuthorizationPromptState {
  queue: AuthorizationPrompt[];
  request: (serverName: string) => Promise<boolean>;
  settle: (id: number, confirmed: boolean) => void;
}

let promptSequence = 0;

export const useAutoOAuthAuthorizationStore = create<AuthorizationPromptState>(
  (set, get) => ({
    queue: [],
    request: (serverName) =>
      new Promise<boolean>((resolve) => {
        set(({ queue }) => ({
          queue: [...queue, { id: ++promptSequence, serverName, resolve }],
        }));
      }),
    settle: (id, confirmed) => {
      const [prompt, ...queue] = get().queue;
      // A dialog's close event may follow its confirm click.
      if (prompt?.id !== id) return;
      set({ queue });
      prompt.resolve(confirmed);
    },
  }),
);

/** Ask before redirecting a connection configured with Auto authentication. */
export function confirmAutoOAuthEscalation(serverName: string): Promise<boolean> {
  return useAutoOAuthAuthorizationStore.getState().request(serverName);
}
