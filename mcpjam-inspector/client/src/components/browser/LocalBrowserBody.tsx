import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { PaneMessage } from "@/components/computer/PaneMessage";
import {
  BrowserPaneSurface,
  type PaneControl,
} from "@/components/browser/BrowserPaneSurface";
import type { BrowserInputEvent, PaneFrame } from "@/lib/browser-pane/input";
import {
  actOnLocalBrowserLease,
  createInputForwarder,
  ensureLocalBrowser,
  fetchLocalBrowserStatus,
  mintLocalBrowserFrameNonce,
  openLocalBrowserFrameStream,
  sendLocalBrowserInput,
  startLocalBrowserInstall,
  type LocalBrowserLease,
  type LocalBrowserStatus,
} from "@/lib/local-browser/client";

/**
 * The frame socket's close codes, mirroring `routes/web/local-browser-frames`.
 *
 * Named here rather than left as bare numbers because the pane's behaviour
 * differs per code: one is worth waiting out, the other never will be.
 */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_LEASE_HELD = 4409;

/** The `sessionStorage` key holding this tab's lease identity. */
const HOLDER_STORAGE_KEY = "mcpjam.localBrowser.holder";

/**
 * A lease identity that survives a reload but not the tab.
 *
 * `sessionStorage` can throw (a private window, blocked site data) and can
 * come back empty, so every path falls back to a fresh in-memory id: losing
 * stability costs a wedged lease until it expires, while throwing here would
 * take the whole pane down.
 */
function usePaneHolderId(): string {
  const ref = useRef<string | null>(null);
  if (ref.current === null) {
    const minted = `rail-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const stored = window.sessionStorage.getItem(HOLDER_STORAGE_KEY);
      if (stored) {
        ref.current = stored;
      } else {
        window.sessionStorage.setItem(HOLDER_STORAGE_KEY, minted);
        ref.current = minted;
      }
    } catch {
      ref.current = minted;
    }
  }
  return ref.current;
}

/**
 * The agent's browser, in the Playground rail.
 *
 * Two things a person needs from it. WATCHING, because an agent driving a
 * browser they cannot see is one they cannot trust or correct. And TAKING
 * OVER, because the agent will hit a CAPTCHA or an SSO prompt it cannot solve,
 * and without a way in the run simply stops.
 *
 * What this file owns is everything the LOCAL engine does differently:
 * downloading a Chromium, minting a frame nonce against device consent, and a
 * lease identity kept in `sessionStorage` because there is no signed-in user
 * to be. The picture, the pointer and the take-control bar are
 * `BrowserPaneSurface`, shared with the hosted pane — what a person does to a
 * rendered browser does not depend on where it runs.
 */
export function LocalBrowserBody({
  projectId,
  consentGranted,
  consentToken,
  active = true,
}: {
  projectId: string | null;
  consentGranted: boolean;
  consentToken: string | null;
  /**
   * Is this pane the rail's visible tab?
   *
   * The pane stays MOUNTED when the user looks at the logs — dropping the
   * socket would stop the screencast and make the browser go dark on every
   * glance — so `document.visibilityState` cannot answer this: the document is
   * still visible, it is this pane that is not. Watching is what defers the
   * idle reap, so a hidden pane must stop claiming somebody is watching.
   */
  active?: boolean;
}) {
  const [status, setStatus] = useState<LocalBrowserStatus | null>(null);
  const [session, setSession] = useState<{ bootId: string } | null>(null);
  const [lease, setLease] = useState<LocalBrowserLease>({ state: "free" });
  const [frame, setFrame] = useState<PaneFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped to re-open the frame socket after it was refused — see the 4401
  // branch below.
  const [streamAttempt, setStreamAttempt] = useState(0);
  /**
   * This pane's identity as a lease holder.
   *
   * Per TAB and stable across reloads, not per mount. It only has to tell one
   * pane from another so two tabs cannot each believe they have control — on a
   * single-user machine the boundary is device consent, and nothing downstream
   * treats this as proof of who anybody is.
   *
   * Stability is what makes it safe, though. A hold that runs out PARKS rather
   * than freeing (a timer expiring is not evidence the private moment is
   * over), and only its holder may hand it back. Minted per mount, reloading
   * while holding left the lease parked under a holder that no longer existed:
   * the agent blocked, every new pane refused, and nothing but restarting the
   * server could clear it. Kept in `sessionStorage` — per tab, surviving a
   * reload, gone when the tab is — the returning pane is recognised as the
   * same hands it was before.
   */
  const holder = usePaneHolderId();
  const holding = lease.state !== "free" && lease.holder === holder;
  // Read inside the heartbeat interval, which must not be torn down and
  // rebuilt (and the socket with it) every time the user changes tab.
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    let cancelled = false;
    void fetchLocalBrowserStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // While Chromium downloads, poll: it is hundreds of megabytes and a screen
  // that looks frozen for several minutes reads as broken.
  useEffect(() => {
    if (status?.install.status !== "installing") return;
    const timer = setInterval(() => {
      void fetchLocalBrowserStatus()
        .then(setStatus)
        .catch(() => {});
    }, 1_000);
    return () => clearInterval(timer);
  }, [status?.install.status]);

  const install = useCallback(async () => {
    setError(null);
    try {
      const { install: state } = await startLocalBrowserInstall(consentToken);
      setStatus((prev) => (prev ? { ...prev, install: state } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [consentToken]);

  /**
   * Which project the state below belongs to.
   *
   * The pane is mounted once and its `projectId` changes underneath it. A
   * session, a lease and a frame are all bound to ONE project's browser, so
   * carrying them across a switch would show one project's page in another's
   * rail — and, worse, aim input at it. A start already in flight is
   * abandoned for the same reason.
   */
  const projectRef = useRef(projectId);
  /**
   * Which browser this pane is looking at, as a number that only goes up.
   *
   * The project id alone cannot say: switch A → B → A and it reads "A" again,
   * so a lease response from the FIRST A is accepted as if it described the
   * browser now on screen — a "you have control" from a browser nobody is
   * watching any more. Two visits to the same project are two different
   * browsers, and so are two `start()` calls within one project; a counter is
   * the only thing that tells them apart.
   */
  const railGeneration = useRef(0);
  // CONSENT REVOKED IS A PRIVACY BOUNDARY, and the surface cannot enforce it:
  // it renders the picture whenever there is one, so a placeholder alone left
  // the last captured frame of somebody's signed-in browser on screen after
  // the grant was withdrawn. The socket does close on its own — its nonce
  // carries a consent fingerprint — but not before the next frame, and never
  // for the one already in state.
  useEffect(() => {
    if (!consentGranted) setFrame(null);
  }, [consentGranted]);

  useEffect(() => {
    if (projectRef.current === projectId) return;
    projectRef.current = projectId;
    railGeneration.current += 1;
    setSession(null);
    setLease({ state: "free" });
    setFrame(null);
    setError(null);
  }, [projectId]);

  const start = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const next = await ensureLocalBrowser(projectId, consentToken);
      // The project may have changed while this was in flight; a late answer
      // describes a browser this rail is no longer looking at.
      if (projectRef.current !== projectId) return;
      // A different browser from here on, even within this project: anything
      // still in flight against the last one must not land on this one.
      railGeneration.current += 1;
      setSession({ bootId: next.bootId });
      setLease(next.lease);
    } catch (err) {
      if (projectRef.current !== projectId) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [projectId, consentToken]);

  // The frame socket. Re-opened when the browser changes; closed on unmount,
  // which is what tells the server to stop encoding JPEGs nobody is watching.
  useEffect(() => {
    if (!session || !projectId) return;
    let closed = false;
    let stream: { close(): void } | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      try {
        const { nonce } = await mintLocalBrowserFrameNonce(
          projectId,
          consentToken,
        );
        if (closed) return;
        const opened = openLocalBrowserFrameStream({
          bootId: session.bootId,
          holder,
          nonce,
        });
        stream = opened;
        opened.socket.onmessage = (event) => {
          try {
            const parsed = JSON.parse(String(event.data)) as {
              type?: string;
              frame?: PaneFrame;
            };
            if (parsed.type === "frame" && parsed.frame) setFrame(parsed.frame);
          } catch {
            // Not our protocol.
          }
        };
        opened.socket.onclose = (event) => {
          if (closed) return;
          if (event.code === CLOSE_LEASE_HELD) {
            // Somebody else holds the browser — including a handoff that
            // happened while this socket was open, which the daemon revokes
            // mid-stream. Not a terminal state: the view has to come back when
            // they hand it back, so keep asking rather than latching an error
            // nothing will ever clear.
            setError(
              "Somebody else has taken control of this browser. The view will resume when they hand it back.",
            );
            setFrame(null);
            retry = setTimeout(() => {
              if (!closed) setStreamAttempt((n) => n + 1);
            }, 3_000);
            return;
          }
          if (event.code === CLOSE_UNAUTHORIZED) {
            // TERMINAL, and told apart from the refusal above by its own code.
            // The nonce is spent or consent moved underneath us; retrying on a
            // timer would burn credentials against the same answer forever and
            // report it as somebody else's handoff the whole time.
            setError(
              event.reason ||
                "This machine's authorization changed. Reopen the pane to watch again.",
            );
            setFrame(null);
          }
        };
        opened.socket.onopen = () => {
          // Whatever refused the last attempt is over.
          setError(null);
        };
        // Only while somebody is actually LOOKING: the document being visible
        // is not enough, because this pane stays mounted behind the Logs tab.
        // Watching is what defers the idle reap, so a pane nobody is looking
        // at must stop claiming otherwise.
        heartbeat = setInterval(() => {
          if (!activeRef.current) return;
          if (document.visibilityState !== "visible") return;
          if (opened.socket.readyState !== WebSocket.OPEN) return;
          opened.socket.send(JSON.stringify({ type: "ping" }));
        }, 20_000);
      } catch (err) {
        if (!closed) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (retry) clearTimeout(retry);
      stream?.close();
    };
  }, [session, projectId, consentToken, holder, streamAttempt]);

  const setLeaseAction = useCallback(
    async (action: "acquire" | "resume") => {
      if (!session) return;
      const generation = railGeneration.current;
      setError(null);
      try {
        const { lease: next } = await actOnLocalBrowserLease(
          { bootId: session.bootId, action, holder },
          consentToken,
        );
        // A lease belongs to ONE browser. If the pane moved on while this was
        // in flight — another project, or another browser in this one —
        // applying it would show control of something nobody is watching.
        if (railGeneration.current !== generation) return;
        setLease(next);
      } catch (err) {
        if (railGeneration.current !== generation) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [session, holder, consentToken],
  );

  // Keep the lease alive while somebody is holding it: it expires into
  // `parked` on purpose, and a person mid-login should not have to re-take a
  // browser they never let go of.
  useEffect(() => {
    if (!holding || !session) return;
    const timer = setInterval(() => {
      void actOnLocalBrowserLease(
        { bootId: session.bootId, action: "heartbeat", holder },
        consentToken,
      ).catch(() => {});
    }, 60_000);
    return () => clearInterval(timer);
  }, [holding, session, holder, consentToken]);

  // Hand the browser back when this tab goes away.
  //
  // Best-effort, and deliberately not the only defence: `keepalive` lets the
  // request outlive the page, but a hard crash or a dropped connection sends
  // nothing — which is why the holder identity is stable across reloads too.
  // Releasing here is the difference between the agent carrying on at once and
  // it waiting out a hold nobody is on the other end of.
  useEffect(() => {
    if (!holding || !session) return;
    const bootId = session.bootId;
    const release = () => {
      void actOnLocalBrowserLease(
        { bootId, action: "resume", holder },
        consentToken,
        { keepalive: true },
      ).catch(() => {});
    };
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, [holding, session, holder, consentToken]);

  // One POST in flight, the rest queued and consecutive moves collapsed. A
  // drag otherwise fires a request per animation frame, and requests that
  // overtake each other put the pointer somewhere it never went.
  // One forwarder per HOLD, not per session. Whatever it has queued belonged
  // to the hold that queued it, so a hand-back, an expiry or a project switch
  // must retire it rather than let its tail arrive under whoever holds the
  // browser next — which is what the cleanup below does, and why the identity
  // includes `holding`.
  const forwarder = useMemo(() => {
    if (!session || !holding) return null;
    const bootId = session.bootId;
    return createInputForwarder((events) =>
      sendLocalBrowserInput({ bootId, holder, events }, consentToken),
    );
  }, [session, holding, holder, consentToken]);
  useEffect(() => () => forwarder?.cancel(), [forwarder]);

  const send = useCallback(
    (events: BrowserInputEvent[]) => {
      if (!forwarder || !holding || events.length === 0) return;
      forwarder.push(events);
    },
    [forwarder, holding],
  );

  /**
   * What this pane shows when there is no picture yet.
   *
   * `undefined` for the one case every engine shares — a session exists and the
   * first frame has not landed — which the surface answers itself.
   */
  const placeholder = (() => {
    if (!consentGranted) {
      // A pointer, not a second consent gate: the Computer tab owns the grant.
      return (
        <PaneMessage dashed>
          <span data-testid="rail-browser-unconsented">
            This machine isn&apos;t authorized yet. Open the Computer tab to
            allow the agent to use it.
          </span>
        </PaneMessage>
      );
    }
    if (status && !status.installed) {
      const { install: state } = status;
      return (
        <PaneMessage dashed>
          <span data-testid="rail-browser-needs-chromium">
            The agent needs a browser on this machine.
          </span>
          {state.status === "installing" ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Downloading Chromium
              {state.percent !== undefined ? ` — ${state.percent}%` : "…"}
            </span>
          ) : (
            <Button size="sm" onClick={() => void install()}>
              Install Chromium
            </Button>
          )}
          {state.status === "failed" ? (
            <span className="text-destructive">{state.error}</span>
          ) : null}
        </PaneMessage>
      );
    }
    if (!session) {
      return (
        <PaneMessage dashed>
          <span data-testid="rail-browser-idle">
            No browser is running for this project yet.
          </span>
          <Button
            size="sm"
            disabled={busy || !projectId}
            onClick={() => void start()}
          >
            {busy ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Open the browser
          </Button>
        </PaneMessage>
      );
    }
    return undefined;
  })();

  const control: PaneControl =
    lease.state === "free"
      ? "agent"
      : holding
        ? "you"
        : lease.holderKind === "script"
          ? "script"
          : "other";

  return (
    <BrowserPaneSurface
      // Gated as well as cleared: a frame that lands in the same tick as the
      // revocation must not be the one that gets painted.
      frame={consentGranted ? frame : null}
      holding={holding}
      control={control}
      // Offered only when there is a browser to take and nobody has it. A
      // lease held by somebody else is not something this pane may step over.
      onTakeControl={
        session && !holding && lease.state === "free"
          ? () => void setLeaseAction("acquire")
          : undefined
      }
      onHandBack={
        session && holding ? () => void setLeaseAction("resume") : undefined
      }
      onInput={send}
      placeholder={placeholder}
      error={error}
      active={active}
    />
  );
}
