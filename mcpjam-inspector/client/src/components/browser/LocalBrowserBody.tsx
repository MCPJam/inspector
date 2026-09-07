import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { PaneMessage } from "@/components/computer/PaneMessage";
import {
  BrowserPaneSurface,
  type PaneControl,
} from "@/components/browser/BrowserPaneSurface";
import { ElectronNativeBody } from "@/components/browser/ElectronNativeBody";
import type { BrowserInputEvent, PaneFrame } from "@/lib/browser-pane/input";
import { paneFrameStats } from "@/lib/browser-pane/frame-stats";
import { createFrameWireReader } from "@/lib/browser-pane/frame-wire";
import { captureBrowserPaneSessionSummary } from "@/lib/browser-pane/session-summary";
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
  /**
   * The live socket and what it said it could do — see the hosted pane's twin.
   *
   * A ref, so a reconnect does not rebuild the input forwarder mid-drag and
   * drop its queue, and because `hello` lands after the forwarder exists.
   */
  const socketRef = useRef<WebSocket | null>(null);
  const socketInputRef = useRef(false);
  /** The seq on screen when a gesture goes, for the input→paint sample. */
  const frameSeqRef = useRef(0);
  const holding = lease.state !== "free" && lease.holder === holder;
  /**
   * Can THIS build show a real view, rather than a picture of one?
   *
   * Asked of the main process, and separately from the server's `surface`:
   * the server answers "this engine has views to show", and this answers "this
   * Electron and this preload can show them". A desktop app older than this
   * wave says `installed` and `runtime: "electron"` exactly as a new one does
   * and has no channel to ask — so a pane that branched on the server's answer
   * alone would render a slot nothing ever paints into.
   *
   * `null` means not asked yet, which is deliberately NOT native: the frames
   * path is what has always worked, and no socket opens before there is a
   * browser anyway.
   */
  const [nativeCapable, setNativeCapable] = useState<boolean | null>(null);
  useEffect(() => {
    const api = window.electronAPI?.agentBrowser;
    if (!api) {
      setNativeCapable(false);
      return;
    }
    let cancelled = false;
    void api
      .capability()
      .then((result) => {
        if (!cancelled) setNativeCapable(Boolean(result?.available));
      })
      .catch(() => {
        if (!cancelled) setNativeCapable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  /**
   * Show the page itself rather than a screencast of it.
   *
   * THREE conditions, and each rules out a different way this can be wrong:
   * the engine is Electron, the server built its context with views
   * (`MCPJAM_BROWSER_NATIVE_SURFACE=false` turns that off without a rebuild),
   * and this app can actually place one.
   */
  const native =
    status?.runtime === "electron" &&
    status?.surface === "native" &&
    nativeCapable === true;
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
    // NOT ON THE NATIVE SURFACE. There is nothing to watch: the page is a real
    // view in the app's own window, and opening this socket would make the
    // engine encode JPEGs at 30 fps that no pane ever draws.
    if (!session || !projectId || native) return;
    let closed = false;
    let stream: { close(): void } | null = null;
    /**
     * This attempt's socket, captured for the cleanup.
     *
     * Compared by IDENTITY on teardown so a reconnect that already replaced
     * the ref is not cleared by the closure of the connection it replaced —
     * which would leave the pane POSTing input while a perfectly good socket
     * was open.
     */
    let openedSocket: WebSocket | null = null;
    /** Decodes the binary pixel path; null until the socket is open. */
    let wire: ReturnType<typeof createFrameWireReader> | null = null;
    /** The last bitmap this socket produced, so teardown can release it. */
    let lastBitmap: ImageBitmap | undefined;
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
          // Worth it even on loopback, where base64 costs a memcpy rather than
          // a network hop: it means the hosted path's decoder runs on every
          // local session instead of only on staging.
          wire: "binary",
        });
        stream = opened;
        wire = createFrameWireReader({
          onFrame: (decoded) => {
            if (closed) return;
            paneFrameStats.noteTransport("jpeg-binary");
            paneFrameStats.noteFrameArrived({ bytes: decoded.bytes });
            frameSeqRef.current = decoded.seq;
            lastBitmap = decoded.bitmap;
            setFrame({
              bitmap: decoded.bitmap,
              deviceWidth: decoded.deviceWidth,
              deviceHeight: decoded.deviceHeight,
              scale: decoded.scale,
              ts: decoded.relayTs,
              relayTs: decoded.relayTs,
              seq: decoded.seq,
            });
          },
          onHeartbeat: (daemon) => {
            if (daemon) paneFrameStats.noteDaemonStats(daemon as never);
          },
          onFatal: () => {
            // A reader that has lost its place in a byte stream can never find
            // it again, so the connection goes rather than the record.
            opened.close();
          },
        });
        openedSocket = opened.socket;
        socketRef.current = opened.socket;
        socketInputRef.current = false;
        paneFrameStats.noteTransport("jpeg-json");
        opened.socket.onmessage = (event) => {
          // Bytes for pixels, text for control, on one socket — see the hosted
          // pane's twin.
          if (typeof event.data !== "string") {
            wire?.push(event.data as ArrayBuffer);
            return;
          }
          try {
            const raw = String(event.data);
            const parsed = JSON.parse(raw) as {
              type?: string;
              frame?: PaneFrame;
              t?: number;
              framesIn?: number;
              framesOut?: number;
              bytes?: number;
              dropped?: number;
              subscribers?: number;
              daemon?: Record<string, unknown>;
            };
            if (parsed.type === "hello") {
              const features = Array.isArray(
                (parsed as { features?: unknown }).features,
              )
                ? ((parsed as { features: unknown[] }).features as unknown[])
                : [];
              socketInputRef.current = features.includes("input");
              return;
            }
            if (parsed.type === "input_ack") {
              const ack = parsed as unknown as { seq?: number };
              if (typeof ack.seq === "number") {
                paneFrameStats.noteInputAck(ack.seq);
              }
              return;
            }
            if (parsed.type === "pong") {
              if (typeof parsed.t === "number") {
                paneFrameStats.noteRtt(Date.now() - parsed.t);
              }
              return;
            }
            if (parsed.type === "stats") {
              paneFrameStats.noteRelayStats({
                framesIn: parsed.framesIn ?? 0,
                ...(parsed.framesOut !== undefined
                  ? { framesOut: parsed.framesOut }
                  : {}),
                bytes: parsed.bytes ?? 0,
                dropped: parsed.dropped ?? 0,
                subscribers: parsed.subscribers ?? 0,
                ...(parsed.daemon ? { daemon: parsed.daemon as never } : {}),
              });
              return;
            }
            if (parsed.type === "frame" && parsed.frame) {
              paneFrameStats.noteFrameArrived({ bytes: raw.length });
              frameSeqRef.current = parsed.frame.seq;
              setFrame(parsed.frame);
            }
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
          opened.socket.send(JSON.stringify({ type: "ping", t: Date.now() }));
        }, 20_000);
      } catch (err) {
        if (!closed) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      closed = true;
      wire?.close();
      // The pane releases each bitmap as the next replaces it; the LAST one
      // has no successor.
      lastBitmap?.close();
      if (heartbeat) clearInterval(heartbeat);
      if (retry) clearTimeout(retry);
      if (socketRef.current === openedSocket) {
        socketRef.current = null;
        socketInputRef.current = false;
      }
      stream?.close();
    };
  }, [session, projectId, consentToken, holder, streamAttempt, native]);

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
    return createInputForwarder(
      (events, seq) => {
        paneFrameStats.noteInputSent(frameSeqRef.current, seq);
        const socket = socketRef.current;
        if (socketInputRef.current && socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "input", seq, events }));
          return;
        }
        return sendLocalBrowserInput({ bootId, holder, events }, consentToken);
      },
      { serialize: () => !socketInputRef.current },
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

  // One analytics event per pane, on the way out — see `session-summary`.
  // `local-native` is its OWN engine in the summary, not a flavour of
  // `electron`: the whole point of the wave is that the two are answerable
  // apart, and a report that called them the same thing could not say whether
  // the native surface helped.
  const engineRef = useRef<string>("local");
  engineRef.current = native ? "local-native" : (status?.runtime ?? "local");
  useEffect(
    () => () => captureBrowserPaneSessionSummary(engineRef.current),
    [],
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

  // The page ITSELF, in the app's own window — no encoder, no socket, no
  // decode. Everything above is unchanged and still applies: the same status,
  // the same lease, the same holder identity, the same take-control bar. What
  // differs is only that there is no picture to draw.
  if (native) {
    return (
      <ElectronNativeBody
        session={session}
        holder={holder}
        control={control}
        holding={holding}
        consentGranted={consentGranted}
        onTakeControl={
          session && !holding && lease.state === "free"
            ? () => void setLeaseAction("acquire")
            : undefined
        }
        onHandBack={
          session && holding ? () => void setLeaseAction("resume") : undefined
        }
        placeholder={placeholder}
        error={error}
        active={active}
        engine="local-native"
      />
    );
  }

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
      engine={status?.runtime ?? "local"}
    />
  );
}
