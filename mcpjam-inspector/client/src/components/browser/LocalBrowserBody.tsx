import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Hand, Loader2, MousePointer2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { PaneMessage } from "@/components/computer/PaneMessage";
import {
  actOnLocalBrowserLease,
  createInputForwarder,
  ensureLocalBrowser,
  fetchLocalBrowserStatus,
  mintLocalBrowserFrameNonce,
  modifiersOf,
  openLocalBrowserFrameStream,
  sendLocalBrowserInput,
  startLocalBrowserInstall,
  toPageCoordinates,
  type LocalBrowserFrame,
  type LocalBrowserInputEvent,
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

/** The DOM's button numbering, in the daemon's names. */
function buttonOf(event: { button?: number }): "left" | "middle" | "right" {
  if (event.button === 1) return "middle";
  if (event.button === 2) return "right";
  return "left";
}

/**
 * The agent's browser, in the Playground rail.
 *
 * Two things a person needs from it. WATCHING, because an agent driving a
 * browser they cannot see is one they cannot trust or correct. And TAKING
 * OVER, because the agent will hit a CAPTCHA or an SSO prompt it cannot solve,
 * and without a way in the run simply stops.
 *
 * Taking over is explicit — a button, not a click into the picture. While
 * nobody holds the browser the agent may be mid-turn, and two drivers on one
 * page is exactly what the lease exists to prevent; the server refuses input
 * that arrives without one, so the button is the honest shape of the rule
 * rather than decoration over it.
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
  const [frame, setFrame] = useState<LocalBrowserFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped to re-open the frame socket after it was refused — see the 4401
  // branch below.
  const [streamAttempt, setStreamAttempt] = useState(0);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  /**
   * Which button this pane is holding down, if any.
   *
   * The BUTTON, not a boolean: a drag started with the middle or right button
   * has to be released with that same one, or the page is left holding it
   * while a left-release it never saw goes somewhere else.
   */
  const draggingRef = useRef<"left" | "middle" | "right" | null>(null);

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

  // Taking control moves the KEYBOARD, not just the lease: the click that
  // acquired it left focus on the button, so everything typed afterwards went
  // to the button and nothing reached the page.
  useEffect(() => {
    if (!holding || !active) return;
    paneRef.current?.focus();
  }, [holding, active]);

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
  useEffect(() => {
    if (projectRef.current === projectId) return;
    projectRef.current = projectId;
    railGeneration.current += 1;
    setSession(null);
    setLease({ state: "free" });
    setFrame(null);
    setError(null);
    draggingRef.current = null;
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
              frame?: LocalBrowserFrame;
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
    (events: LocalBrowserInputEvent[]) => {
      if (!forwarder || !holding || events.length === 0) return;
      forwarder.push(events);
    },
    [forwarder, holding],
  );

  const pointAt = useCallback(
    (event: React.MouseEvent, options: { clampToPage?: boolean } = {}) => {
      const image = imageRef.current;
      if (!image || !frame) return null;
      return toPageCoordinates(event, image, frame, options);
    },
    [frame],
  );

  const paneBody = () => {
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
          <Button size="sm" disabled={busy || !projectId} onClick={() => void start()}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Open the browser
          </Button>
        </PaneMessage>
      );
    }
    if (!frame) {
      return (
        <PaneMessage>
          <span className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Waiting for the first frame…
          </span>
        </PaneMessage>
      );
    }
    return (
      <img
        ref={imageRef}
        data-testid="rail-browser-frame"
        alt="The agent's browser"
        src={`data:image/jpeg;base64,${frame.data}`}
        className="h-full w-full select-none object-contain"
        draggable={false}
        onMouseMove={(event) => {
          // Mid-drag a move must still land, even over a letterbox bar: the
          // page is tracking the pointer and a gap reads as a jump.
          const point = pointAt(event, {
            clampToPage: draggingRef.current !== null,
          });
          if (point) send([{ type: "mouse_move", ...point, modifiers: modifiersOf(event) }]);
        }}
        onMouseDown={(event) => {
          // A press that starts on a bar is still dropped: the page has
          // nothing there, and inventing a target clicks where nobody aimed.
          const point = pointAt(event);
          if (!point) return;
          draggingRef.current = buttonOf(event);
          send([
            {
              type: "mouse_down",
              ...point,
              button: buttonOf(event),
              clickCount: event.detail || 1,
              modifiers: modifiersOf(event),
            },
          ]);
        }}
        onMouseUp={(event) => {
          // The release always lands. Dropping it because the pointer drifted
          // onto a bar leaves the page holding the button down forever, stuck
          // mid-selection with no way for the person to let go.
          const point = pointAt(event, {
            clampToPage: draggingRef.current !== null,
          });
          draggingRef.current = null;
          if (!point) return;
          send([
            {
              type: "mouse_up",
              ...point,
              button: buttonOf(event),
              clickCount: event.detail || 1,
              modifiers: modifiersOf(event),
            },
          ]);
        }}
        onMouseLeave={(event) => {
          // Leaving the element mid-drag ends it, for the same reason — with
          // the button that was actually pressed, not always the left one.
          const held = draggingRef.current;
          if (!held) return;
          const point = pointAt(event, { clampToPage: true });
          draggingRef.current = null;
          if (point) {
            send([
              {
                type: "mouse_up",
                ...point,
                button: held,
                modifiers: modifiersOf(event),
              },
            ]);
          }
        }}
        onContextMenu={(event) => {
          // The page gets the right-click; the host's own menu would cover it.
          if (holding) event.preventDefault();
        }}
        onWheel={(event) => {
          const point = pointAt(event);
          if (!point) return;
          send([
            {
              type: "wheel",
              ...point,
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              modifiers: modifiersOf(event),
            },
          ]);
        }}
      />
    );
  };

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {lease.state === "free"
            ? "The agent is driving"
            : holding
              ? "You have control"
              : `${lease.holderKind === "script" ? "A script" : "Someone else"} has control`}
        </span>
        {session ? (
          holding ? (
            <Button size="sm" variant="outline" onClick={() => void setLeaseAction("resume")}>
              <Hand className="mr-1.5 h-3.5 w-3.5" />
              Hand back
            </Button>
          ) : lease.state === "free" ? (
            <Button size="sm" onClick={() => void setLeaseAction("acquire")}>
              <MousePointer2 className="mr-1.5 h-3.5 w-3.5" />
              Take control
            </Button>
          ) : null
        ) : null}
      </div>
      <div
        ref={paneRef}
        className="min-h-0 flex-1 px-3 pb-3 outline-none"
        // Keys go to the page only while this pane holds the browser.
        tabIndex={holding ? 0 : -1}
        onKeyDown={(event) => {
          if (!holding) return;
          event.preventDefault();
          // A printable character is inserted as TEXT: paste and IME
          // composition have no keystrokes to replay, and a key table that
          // tried would be wrong for every non-US layout.
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
            send([{ type: "text", text: event.key }]);
            return;
          }
          send([
            { type: "key_down", key: event.key, code: event.code, modifiers: modifiersOf(event) },
            { type: "key_up", key: event.key, code: event.code, modifiers: modifiersOf(event) },
          ]);
        }}
      >
        {paneBody()}
      </div>
      {error ? (
        <div className="shrink-0 px-3 pb-2 text-xs text-destructive">{error}</div>
      ) : null}
    </>
  );
}
