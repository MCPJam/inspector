/**
 * Browser Panel — watch the browser an agent is driving, and take it when a
 * login or a challenge needs a person.
 *
 * Two states that matter, and the difference between them is the whole
 * feature:
 *
 *   WATCHING (default) — anyone with the panel open can see what the agent is
 *     doing, without taking anything. This is deliberately the default (L10):
 *     making people take control just to look would push them into the
 *     disruptive action every time.
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
 *
 * THE STREAM PASSWORD IS NOT AVAILABLE HERE, and that is the point. It used to
 * arrive in `GET /session` and get pasted into an iframe URL, which put the
 * credential for the entire desktop into every watcher's browser. The full
 * desktop now opens through `POST /open-desktop` → a one-shot ticket → a
 * server-side redirect, and opening it TAKES THE LEASE, because the desktop
 * drives the page outside the daemon where the lease would otherwise never see
 * the person.
 *
 * The embedded live view is therefore absent until the shared viewport lands
 * (I-7): this component is not mounted anywhere yet, and the rail's browser
 * body is where a watcher will actually watch.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
  /** Where the desktop lives. Useless on its own — it authenticates nobody —
   *  and deliberately not enough to open: see `openDesktop`. */
  streamUrl: string;
  lease: LeaseState;
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

  /**
   * Take the browser and open the full desktop in a new tab.
   *
   * One action, not two, because on the server they are one action: the ticket
   * is only minted once the lease has been taken. Pretending otherwise in the
   * UI would let someone press "Open" and be told no.
   */
  const openDesktop = useCallback(async () => {
    setBusy(true);
    // OPENED SYNCHRONOUSLY, inside the click. A `window.open` that happens
    // after an await has lost the user gesture, and every popup blocker
    // refuses it — so the tab is claimed now, parked on `about:blank`, and
    // pointed at the desktop once the POST answers. `noopener` cannot be used
    // for that, because it makes `window.open` return null and there would be
    // no tab to redirect; clearing `opener` by hand is the same guarantee.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      if (!tab) {
        // NO SAME-TAB FALLBACK. Navigating this tab away would take the lease
        // heartbeat with it — the desktop has none of its own — so the hold
        // would park a couple of minutes into an active session and the agent
        // would find the browser blocked by somebody who had "left".
        setError(
          "Allow pop-ups for this site to open the full desktop in a new tab.",
        );
        return;
      }
      // One token for both hops: the POST takes the lease, and the navigation
      // presents the same ~60s token in `?t=` because a top-level navigation
      // cannot carry a header.
      const { token } = await mintBrowserToken({ projectId });
      const res = await fetch("/api/web/computers/browser/open-desktop", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      if (!res.ok) {
        tab.close();
        setError(
          body?.error === "lease_held"
            ? "Someone else is using this browser right now."
            : "Could not open the desktop.",
        );
        return;
      }
      setHolding(true);
      setError(null);
      // `replace`, so the blank page does not sit in that tab's history with
      // the token after it.
      tab.location.replace(
        `/api/web/computers/browser/desktop?t=${encodeURIComponent(token)}`,
      );
      await refresh();
    } catch (cause) {
      // Never rethrow: the caller is `void openDesktop()`, so a throw here is
      // an unhandled rejection and the primary action appears to do nothing.
      tab?.close();
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [mintBrowserToken, projectId, refresh]);

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

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
        <p>
          The live view moves into the playground rail; this panel currently
          opens the desktop itself.
        </p>
        <button
          type="button"
          // `parked` too, not just `held`: a hold that ran out is still
          // somebody's, and the server refuses the acquire behind this button.
          // "Take control" stays the explicit way to ask for it.
          disabled={busy || heldByOther || parked}
          onClick={() => void openDesktop()}
          className="rounded border px-3 py-1.5"
        >
          Open full desktop
        </button>
        <p className="max-w-sm text-xs">
          Opening it takes control: the desktop drives the page outside the
          agent&apos;s browser, so the agent is stopped while you are there.
        </p>
      </div>
    </div>
  );
}

export default BrowserPanel;
