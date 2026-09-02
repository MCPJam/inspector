import { useCallback, useEffect, useRef, useState } from "react";
import { Hand, Loader2, MousePointer2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { PaneMessage } from "@/components/computer/PaneMessage";
import {
  actOnLocalBrowserLease,
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
}: {
  projectId: string | null;
  consentGranted: boolean;
  consentToken: string | null;
}) {
  const [status, setStatus] = useState<LocalBrowserStatus | null>(null);
  const [session, setSession] = useState<{ bootId: string } | null>(null);
  const [lease, setLease] = useState<LocalBrowserLease>({ state: "free" });
  const [frame, setFrame] = useState<LocalBrowserFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);

  /**
   * This pane's identity as a lease holder.
   *
   * Per MOUNT, not per user: it only has to tell one pane from another so two
   * tabs cannot each believe they have control. On a single-user machine the
   * boundary is device consent, and nothing downstream treats this as proof of
   * who anybody is.
   */
  const holderRef = useRef<string>(
    `rail-${Math.random().toString(36).slice(2, 10)}`,
  );
  const holder = holderRef.current;
  const holding = lease.state !== "free" && lease.holder === holder;

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

  const start = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const next = await ensureLocalBrowser(projectId, consentToken);
      setSession({ bootId: next.bootId });
      setLease(next.lease);
    } catch (err) {
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
          if (!closed && event.code === 4401) {
            setError(
              "Somebody else has taken control of this browser. The view will resume when they hand it back.",
            );
          }
        };
        // Only while the tab is VISIBLE: a hidden pane is not a person
        // watching, and the browser should be reapable while nobody is.
        heartbeat = setInterval(() => {
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
      stream?.close();
    };
  }, [session, projectId, consentToken, holder]);

  const setLeaseAction = useCallback(
    async (action: "acquire" | "resume") => {
      if (!session) return;
      setError(null);
      try {
        const { lease: next } = await actOnLocalBrowserLease(
          { bootId: session.bootId, action, holder },
          consentToken,
        );
        setLease(next);
      } catch (err) {
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

  const send = useCallback(
    (events: LocalBrowserInputEvent[]) => {
      if (!session || !holding || events.length === 0) return;
      void sendLocalBrowserInput(
        { bootId: session.bootId, holder, events },
        consentToken,
      ).catch(() => {
        // A refused event is not worth an error banner: the most likely cause
        // is the lease expiring, and the next lease read says so.
      });
    },
    [session, holding, holder, consentToken],
  );

  const pointAt = useCallback(
    (event: React.MouseEvent) => {
      const image = imageRef.current;
      if (!image || !frame) return null;
      return toPageCoordinates(event, image, frame);
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
          const point = pointAt(event);
          if (point) send([{ type: "mouse_move", ...point, modifiers: modifiersOf(event) }]);
        }}
        onMouseDown={(event) => {
          const point = pointAt(event);
          if (!point) return;
          send([
            {
              type: "mouse_down",
              ...point,
              button: "left",
              clickCount: event.detail || 1,
              modifiers: modifiersOf(event),
            },
          ]);
        }}
        onMouseUp={(event) => {
          const point = pointAt(event);
          if (!point) return;
          send([
            {
              type: "mouse_up",
              ...point,
              button: "left",
              clickCount: event.detail || 1,
              modifiers: modifiersOf(event),
            },
          ]);
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
        className="min-h-0 flex-1 px-3 pb-3"
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
