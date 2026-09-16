/**
 * Browser Panel — watch the browser an agent is driving, and take it when a
 * login or a challenge needs a person.
 *
 * Two states that matter, and the difference between them is the whole
 * feature:
 *
 *   WATCHING (default) — the noVNC stream is embedded view-only. Anyone with
 *     the panel open can see what the agent is doing. This is deliberately the
 *     default (L10): making people take control just to look would push them
 *     into the disruptive action every time.
 *
 *   HOLDING — the person clicked "Take control". The daemon now refuses every
 *     model-driven command AND every observation (a 423 before the queue), so
 *     nothing captures the screen while a password is on it. The stream turns
 *     interactive. Handing back is explicit, and the agent is told the page may
 *     have changed.
 *
 * A lease that stops being heartbeaten PARKS rather than freeing: if this tab
 * is closed mid-login, the agent does not resume underneath the person. That
 * is a deliberate bias toward "stuck" over "surprising"; the panel says so.
 *
 * Nothing here is persisted. The stream is live only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserStream } from "./BrowserStream";
import { BrowserProfileSaveButton } from "@/components/browser/BrowserProfileSaveButton";
import {
  useMintBrowserToken,
  useMintConversationBrowserToken,
} from "@/hooks/useProjectComputer";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import { BROWSER_SESSION_ID_HEADER } from "@/shared/browser-session-header";

/** Heartbeat cadence while holding the lease (the daemon TTL is 2 minutes). */
const LEASE_HEARTBEAT_MS = 30_000;
/** Keepalive cadence while merely watching. */
const KEEPALIVE_MS = 60_000;
/** Re-mint this long before a token actually lapses, to cover clock skew. */
const TOKEN_EXPIRY_BUFFER_MS = 5_000;

/**
 * The backend's code for "there is no browser to attach to" — one was never
 * reserved, or it was released or auto-paused under an open panel.
 *
 * Expected and user-actionable, not a fault, so the polling loops below must
 * STOP on it. They used to swallow every failure with `.catch(() => {})`,
 * which combined badly with minting a token per request: a single released
 * computer logged one uncaught server error per minute per open tab, for as
 * long as the tab stayed open, while the panel showed nothing at all.
 *
 * Kept in sync with `browserUnavailable` in mcpjam-backend
 * `convex/projectComputers.ts`.
 */
const BROWSER_UNAVAILABLE = "browser_unavailable";

/**
 * The message to show when a mint failed because there is no browser, or
 * `null` when this is some other (possibly transient) failure.
 *
 * Reads the `ConvexError` payload rather than `.message`, because Convex masks
 * the message to "Server Error" in production — the payload is the only part
 * that survives the boundary.
 */
function browserUnavailableMessage(error: unknown): string | null {
  const data = (error as { data?: unknown })?.data;
  if (!data || typeof data !== "object") return null;
  if ((data as { kind?: unknown }).kind !== BROWSER_UNAVAILABLE) return null;
  const message = (data as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0
    ? message
    : "No browser is running on this computer yet.";
}

type LeaseState =
  | { state: "free" }
  | { state: "held"; holder: string; expiresAt?: number }
  | { state: "parked"; holder: string }
  | { state: "unknown" };

interface SessionInfo {
  sessionId: string;
  bootId: string;
  lease: LeaseState;
  // No `streamUrl` or `streamPassword`: the route stopped returning them, and
  // the stream socket authenticates on the server. See `BrowserStream`.
}

export interface BrowserPanelProps {
  projectId: string;
  /** Durable logical browser session, when this panel belongs to a chat. */
  sessionId?: string;
  /** Boot a browser if none is running yet. Off by default: opening a panel
   *  should not start a machine's browser behind the user's back. */
  ensure?: boolean;
}

export function BrowserPanel({
  projectId,
  sessionId,
  ensure = false,
}: BrowserPanelProps) {
  const mintBrowserToken = useMintBrowserToken();
  const mintConversationBrowserToken = useMintConversationBrowserToken();
  const markBrowserSessionActive = useActiveChatSessionStore(
    (state) => state.markBrowserSessionActive,
  );
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [holding, setHolding] = useState(false);
  // A tab that is not visible must not keep a machine awake.
  const visibleRef = useRef(true);
  /** Bumped whenever this panel changes which browser it is looking at. */
  const panelGeneration = useRef(0);
  /** The live browser token, reused until it is nearly expired. */
  const tokenCache = useRef<{
    key: string;
    token: string;
    expiresAt: number;
  } | null>(null);

  /**
   * Which browser the cached token is for. A token minted for one conversation
   * must never be handed to another, so the identity is part of the cache key
   * rather than something a separate effect has to remember to invalidate.
   */
  const tokenKey = sessionId
    ? `session:${projectId}:${sessionId}`
    : `project:${projectId}`;

  /**
   * Mint once per token lifetime, not once per request.
   *
   * Every call used to mint: the keepalive, the lease heartbeat, each lease
   * action, every refresh. Tokens last ~60s, so almost all of that was a round
   * trip to Convex to re-obtain a token still sitting in memory — and when
   * there was no browser to mint for, it was also an uncaught server error per
   * call rather than per token.
   */
  const getToken = useCallback(async (): Promise<string> => {
    const cached = tokenCache.current;
    if (
      cached &&
      cached.key === tokenKey &&
      cached.expiresAt - TOKEN_EXPIRY_BUFFER_MS > Date.now()
    ) {
      return cached.token;
    }
    const minted = sessionId
      ? await mintConversationBrowserToken({
          projectId,
          conversationId: sessionId,
        })
      : await mintBrowserToken({ projectId });
    tokenCache.current = {
      key: tokenKey,
      token: minted.token,
      expiresAt: minted.expiresAt,
    };
    return minted.token;
  }, [
    mintBrowserToken,
    mintConversationBrowserToken,
    projectId,
    sessionId,
    tokenKey,
  ]);

  /** A bare token for the stream socket, which cannot send an auth header. */
  const mintStreamToken = useCallback(() => getToken(), [getToken]);

  const authorized = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      const send = async (token: string) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${token}`);
        if (init.body) headers.set("content-type", "application/json");
        return fetch(`/api/web/computers/browser${path}`, { ...init, headers });
      };

      const response = await send(await getToken());
      // Caching a token means one can now lapse in flight, which minting per
      // request made impossible. Drop it and mint once more — but only once,
      // so a genuinely rejected token cannot become a retry loop. `init.body`
      // is always a string here, so replaying the request is safe.
      if (response.status !== 401) return response;
      tokenCache.current = null;
      return send(await getToken());
    },
    [getToken],
  );

  const exportProfile = useCallback(async () => {
    const response = await authorized("/profile/export", { method: "POST" });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      throw new Error(
        typeof body?.error === "string"
          ? body.error
          : "The hosted browser profile could not be exported.",
      );
    }
    const savedFrom = response.headers.get(BROWSER_SESSION_ID_HEADER) ?? undefined;
    return {
      archive: await response.blob(),
      ...(savedFrom ? { savedFrom } : {}),
    };
  }, [authorized]);

  /**
   * A polling tick failed. Transient failures are ignored as before — the next
   * tick can still succeed. "There is no browser" is not transient: stop, and
   * say so, rather than logging a server error every tick until the tab closes.
   *
   * Clearing `session` and `holding` tears down both intervals through their
   * own effect cleanups, so there is no timer to cancel here.
   */
  const handlePollFailure = useCallback((cause: unknown) => {
    const message = browserUnavailableMessage(cause);
    if (!message) return;
    tokenCache.current = null;
    setSession(null);
    setHolding(false);
    setError(message);
  }, []);

  const refresh = useCallback(async () => {
    // Captured before the await. Clearing state on a switch is not enough on
    // its own: conversation A's refresh can still be in flight and land LAST,
    // writing A's boot over B — and `BrowserStream` then pairs that stale boot
    // with B's token, cannot connect, and leaves the viewer broken until some
    // later refresh happens to fix it.
    const generation = panelGeneration.current;
    const stale = () => panelGeneration.current !== generation;
    try {
      const res = await authorized(`/session${ensure ? "?ensure=1" : ""}`);
      const body = await res.json();
      if (stale()) return;
      if (!res.ok) {
        setSession(null);
        setError(
          body?.error === "no_browser_session"
            ? "No browser is running on this computer yet."
            : (body?.detail ?? body?.error ?? "Could not reach the browser."),
        );
        return;
      }
      setSession(body as SessionInfo);
      if (sessionId) {
        markBrowserSessionActive(sessionId);
        useActiveChatSessionStore
          .getState()
          .setBrowserLocation({ projectId, sessionId, engine: "cloud" });
      }
      setError(null);
    } catch (cause) {
      if (stale()) return;
      setError(
        browserUnavailableMessage(cause) ??
          (cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }, [authorized, ensure, markBrowserSessionActive, projectId, sessionId]);

  /**
   * A conversation switch is a change of BROWSER, so none of this panel's
   * lease state survives it.
   *
   * `holding` in particular: the heartbeat effect below keys on `authorized`,
   * which is rebuilt when `sessionId` changes, so without this reset the panel
   * carried `holding: true` across the switch and began heartbeating the NEW
   * conversation's lease with the new conversation's tokens — a lease it never
   * acquired — while rendering "You have control" over it.
   *
   * It does NOT release the previous conversation's lease. Letting that one
   * park is the documented behaviour (see the note at the top of this file):
   * a lease that stops being heartbeaten parks rather than frees, precisely so
   * an agent cannot resume underneath somebody who walked away mid-login.
   * Freeing it here would trade a deliberate "stuck" for exactly the
   * "surprising" this panel is built to avoid.
   */
  const identityRef = useRef<string | undefined>(sessionId);
  useEffect(() => {
    if (identityRef.current === sessionId) return;
    identityRef.current = sessionId;
    // Anything still in flight against the previous conversation's browser
    // must not land on this one.
    panelGeneration.current += 1;
    tokenCache.current = null;
    setSession(null);
    setHolding(false);
    setBusy(false);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onVisibility = () => {
      visibleRef.current = document.visibilityState === "visible";
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Keepalive while watching — only while the tab is actually visible, and the
  // server decides whether an open panel still counts at all.
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      if (!visibleRef.current) return;
      void authorized("/keepalive", { method: "POST" }).catch(
        handlePollFailure,
      );
    }, KEEPALIVE_MS);
    return () => clearInterval(timer);
  }, [authorized, handlePollFailure, session]);

  // Heartbeat while holding. Stopping (closing the tab, losing the network)
  // parks the lease rather than freeing it, so the agent stays stopped.
  useEffect(() => {
    if (!holding) return;
    const timer = setInterval(() => {
      void authorized("/lease", {
        method: "POST",
        body: JSON.stringify({ action: "heartbeat" }),
      }).catch(handlePollFailure);
    }, LEASE_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [authorized, handlePollFailure, holding]);

  const changeLease = useCallback(
    async (action: "acquire" | "resume") => {
      setBusy(true);
      try {
        const res = await authorized("/lease", {
          method: "POST",
          body: JSON.stringify({ action }),
        });
        const body = await res.json();
        if (!res.ok) {
          setError(
            body?.lease?.holder
              ? "Someone else is using this browser right now."
              : "Could not change control of the browser.",
          );
          return;
        }
        setHolding(action === "acquire");
        setError(null);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [authorized, refresh],
  );

  if (error && !session) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        <p>{error}</p>
        <button
          className="mt-2 underline"
          onClick={() => void refresh()}
          type="button"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Connecting to the browser…
      </div>
    );
  }

  const heldByOther =
    session.lease.state === "held" &&
    !holding &&
    session.lease.holder !== undefined;
  const parked = session.lease.state === "parked";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-3 py-2 text-sm">
        <span className="font-medium">
          {holding ? "You have control" : "Watching"}
        </span>
        {heldByOther && (
          <span className="text-muted-foreground">
            Someone else is using this browser.
          </span>
        )}
        {parked && !holding && (
          <span className="text-muted-foreground">
            Paused — a person took control and has not handed it back.
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <BrowserProfileSaveButton
            projectId={projectId}
            exportArchive={exportProfile}
            disabled={holding || busy}
          />
          {holding ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void changeLease("resume")}
              className="rounded border px-2 py-1"
            >
              Hand back to the agent
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || heldByOther}
              onClick={() => void changeLease("acquire")}
              className="rounded border px-2 py-1"
            >
              Take control
            </button>
          )}
        </div>
      </div>

      {holding && (
        <p className="border-b px-3 py-2 text-xs text-muted-foreground">
          While you have control, the agent is stopped and nothing is being
          captured — no screenshots, no page text. Hand control back when you
          are done; the agent will be told the page may have changed.
        </p>
      )}

      {/* The stream comes through our own RFB proxy, not from an iframe
          carrying the desktop's password in its URL. `viewOnly` here stops a
          stray click from being sent at all; the gate that actually holds is
          server-side, where a client cannot opt out of it. */}
      <BrowserStream
        mintToken={mintStreamToken}
        viewOnly={!holding}
        bootId={session.bootId}
      />
    </div>
  );
}

export default BrowserPanel;
