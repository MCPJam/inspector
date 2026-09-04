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
import { useMintBrowserToken } from "@/hooks/useProjectComputer";

/** Heartbeat cadence while holding the lease (the daemon TTL is 2 minutes). */
const LEASE_HEARTBEAT_MS = 30_000;
/** Keepalive cadence while merely watching. */
const KEEPALIVE_MS = 60_000;

type LeaseState =
  | { state: "free" }
  | { state: "held"; holder: string; expiresAt?: number }
  | { state: "parked"; holder: string }
  | { state: "unknown" };

interface SessionInfo {
  bootId: string;
  lease: LeaseState;
  // No `streamUrl` or `streamPassword`: the route stopped returning them, and
  // the stream socket authenticates on the server. See `BrowserStream`.
}

export interface BrowserPanelProps {
  projectId: string;
  /** Boot a browser if none is running yet. Off by default: opening a panel
   *  should not start a machine's browser behind the user's back. */
  ensure?: boolean;
}

export function BrowserPanel({ projectId, ensure = false }: BrowserPanelProps) {
  const mintBrowserToken = useMintBrowserToken();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [holding, setHolding] = useState(false);
  // A tab that is not visible must not keep a machine awake.
  const visibleRef = useRef(true);

  /** Every call mints its own token: they last ~60s, so caching one across a
   *  panel's lifetime would just produce expiry failures. */
  /** A bare token for the stream socket, which cannot send an auth header. */
  const mintStreamToken = useCallback(async () => {
    const { token } = await mintBrowserToken({ projectId });
    return token;
  }, [mintBrowserToken, projectId]);

  const authorized = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      const { token } = await mintBrowserToken({ projectId });
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      if (init.body) headers.set("content-type", "application/json");
      return fetch(`/api/web/computers/browser${path}`, { ...init, headers });
    },
    [mintBrowserToken, projectId],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await authorized(`/session${ensure ? "?ensure=1" : ""}`);
      const body = await res.json();
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
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [authorized, ensure]);

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
      void authorized("/keepalive", { method: "POST" }).catch(() => {});
    }, KEEPALIVE_MS);
    return () => clearInterval(timer);
  }, [authorized, session]);

  // Heartbeat while holding. Stopping (closing the tab, losing the network)
  // parks the lease rather than freeing it, so the agent stays stopped.
  useEffect(() => {
    if (!holding) return;
    const timer = setInterval(() => {
      void authorized("/lease", {
        method: "POST",
        body: JSON.stringify({ action: "heartbeat" }),
      }).catch(() => {});
    }, LEASE_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [authorized, holding]);

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
