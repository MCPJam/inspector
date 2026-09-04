import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { PaneMessage } from "@/components/computer/PaneMessage";
import {
  BrowserPaneSurface,
  type PaneControl,
} from "@/components/browser/BrowserPaneSurface";
import {
  createInputForwarder,
  type BrowserInputEvent,
  type PaneFrame,
} from "@/lib/browser-pane/input";
import {
  actOnHostedBrowserLease,
  createBrowserTokenCache,
  fetchHostedBrowserSession,
  HostedBrowserError,
  openHostedBrowserFrameStream,
  sendHostedBrowserInput,
  type HostedBrowserLease,
  type MintBrowserToken,
} from "@/lib/hosted-browser/client";

/**
 * The agent's HOSTED browser, in the Playground rail.
 *
 * The same two things a person needs as from the local pane — watching, and
 * being able to take over when the agent hits a CAPTCHA or an SSO prompt — and
 * the same surface for both, because a click on a picture of a page does not
 * care which machine drew it. What differs is everything around it: a
 * short-lived signed token instead of device consent, a browser that already
 * exists in a sandbox instead of a Chromium to download, and a metered box
 * that hibernates if nobody says they are looking.
 *
 * THE PAGE, NOT THE DESKTOP. `BrowserPanel` shows the whole desktop over RFB —
 * window manager, dialogs, popups — and stays the right thing for "open the
 * full desktop". This is the daemon's own 1024×768 observation viewport, which
 * is what belongs beside the local and Electron panes in a rail.
 */

/** The frame socket's close codes, mirroring `computer-browser-frames.ts`. */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_NOT_FOUND = 4404;
const CLOSE_LEASE_HELD = 4409;

/** How often the pane says somebody is looking. */
const WATCH_PING_MS = 20_000;
/** How often a held lease is renewed. It parks, not frees, without this. */
const LEASE_HEARTBEAT_MS = 30_000;
/** How long to wait before re-opening a socket that was refused. */
const RETRY_MS = 3_000;
/**
 * Consecutive 4401s tolerated before giving up.
 *
 * A token lasts about a minute, so an expiry mid-view is the NORMAL way a long
 * watch ends and reconnecting with a fresh one is the fix. The cap is for a
 * token being rejected for some other reason, which shows up back to back.
 */
const MAX_TOKEN_RETRIES = 5;

interface Session {
  bootId: string;
  contextMode: "persistent" | "ephemeral";
}

export function HostedBrowserBody({
  projectId,
  mintToken,
  active = true,
}: {
  projectId: string | null;
  /** Mints a fresh ~60s browser token for this project. */
  mintToken: (args: { projectId: string }) => Promise<{
    token: string;
    expiresAt: number;
  }>;
  /**
   * Is this pane the rail's visible tab?
   *
   * The pane stays MOUNTED behind the other tabs, because dropping the socket
   * would stop the screencast and make the browser go dark on every glance. It
   * stops SAYING it is being watched, which is what lets a metered box
   * hibernate rather than being held awake for a picture nobody is looking at.
   */
  active?: boolean;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [lease, setLease] = useState<HostedBrowserLease>({ state: "unknown" });
  const [holding, setHolding] = useState(false);
  const [frame, setFrame] = useState<PaneFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  /** Bumped to re-open the frame socket after it was refused. */
  const [streamAttempt, setStreamAttempt] = useState(0);
  /**
   * CONSECUTIVE 4401s, not 4401s ever — and a REF, deliberately.
   *
   * Every reconnect re-runs the socket effect, so a counter declared inside it
   * resets on each attempt and the cap never binds: the pane would mint
   * tokens against the same refusal forever. Cleared on a socket that opens,
   * because a connection that succeeded proves the last failure was not the
   * kind this cap is for.
   */
  const tokenRetriesRef = useRef(0);

  const activeRef = useRef(active);
  activeRef.current = active;

  /**
   * One token cache per project.
   *
   * Per PROJECT because the token names the computer it authorizes; carrying
   * one across a switch would present another project's computer's credential.
   */
  const tokens = useMemo(() => {
    if (!projectId) return null;
    const mint: MintBrowserToken = () => mintToken({ projectId });
    return createBrowserTokenCache(mint);
  }, [projectId, mintToken]);

  /**
   * Which browser this pane is looking at, as a number that only goes up.
   *
   * The project id alone cannot say: switch A → B → A and a lease answer from
   * the FIRST A is accepted as if it described the browser now on screen — a
   * "you have control" for a browser nobody is watching. Two visits are two
   * different browsers, and so are two `open()` calls within one project.
   */
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setSession(null);
    setLease({ state: "unknown" });
    setHolding(false);
    setFrame(null);
    setError(null);
    setUnavailable(null);
    tokenRetriesRef.current = 0;
  }, [projectId]);

  /** Read the row without starting anything. */
  const refresh = useCallback(
    async (options: { ensure?: boolean } = {}) => {
      if (!tokens) return;
      const mine = generation.current;
      try {
        const next = await fetchHostedBrowserSession(tokens, options);
        if (generation.current !== mine) return;
        setSession({ bootId: next.bootId, contextMode: next.contextMode });
        setLease(next.lease);
        // The SERVER says whether the lease is this viewer's. Tracking "I
        // acquired it" here instead would forget across a reload and then lock
        // this pane out of a parked lease it still holds, since only the
        // holder may hand one back.
        setHolding(next.yours);
        setUnavailable(null);
        setError(null);
      } catch (cause) {
        if (generation.current !== mine) return;
        if (cause instanceof HostedBrowserError && cause.status === 409) {
          // No browser on this computer yet — an offer, not a failure.
          setSession(null);
          setUnavailable(null);
          setError(null);
          return;
        }
        setUnavailable(
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    },
    [tokens],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = useCallback(async () => {
    setBusy(true);
    try {
      // `ensure` ATTACHES to a browser this computer can already run; it never
      // reserves, so opening a pane cannot provision a machine.
      await refresh({ ensure: true });
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  // The frame socket. Re-opened when the browser changes or an attempt was
  // refused; closed on unmount, which is what tells the server to hang up the
  // daemon stream and stop encoding JPEGs nobody is watching.
  useEffect(() => {
    if (!session || !tokens) return;
    let closed = false;
    let stream: { close(): void } | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      let token: string;
      try {
        token = await tokens.get();
      } catch (cause) {
        if (!closed)
          setError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      if (closed) return;

      const opened = openHostedBrowserFrameStream({ token });
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
      opened.socket.onopen = () => {
        // Whatever refused the last attempt is over.
        tokenRetriesRef.current = 0;
        setError(null);
      };
      opened.socket.onclose = (event) => {
        if (closed) return;
        setFrame(null);
        if (event.code === CLOSE_LEASE_HELD) {
          // Somebody else has the browser, including a handoff that happened
          // while this socket was open — the daemon revokes mid-stream. NOT
          // terminal: the view has to come back when they hand it back, so
          // keep asking rather than latching an error nothing will clear.
          setError(
            "Somebody else has taken control of this browser. The view will resume when they hand it back.",
          );
          void refresh();
          retry = setTimeout(() => {
            if (!closed) setStreamAttempt((n) => n + 1);
          }, RETRY_MS);
          return;
        }
        if (event.code === CLOSE_UNAUTHORIZED) {
          // Almost always the ~60s token expiring, which is how a long watch
          // normally ends. Mint a fresh one and reconnect — but bounded, so a
          // token rejected for any other reason cannot spin forever.
          tokens.invalidate();
          if (tokenRetriesRef.current < MAX_TOKEN_RETRIES) {
            tokenRetriesRef.current += 1;
            retry = setTimeout(() => {
              if (!closed) setStreamAttempt((n) => n + 1);
            }, RETRY_MS);
            return;
          }
          setError(
            "This view is no longer authorized. Reopen the pane to watch again.",
          );
          return;
        }
        if (event.code === CLOSE_NOT_FOUND) {
          // The browser stopped. Offer to open one rather than retrying at a
          // machine that has nothing to show.
          setSession(null);
          setHolding(false);
          return;
        }
        // A drop. Reconnect.
        retry = setTimeout(() => {
          if (!closed) setStreamAttempt((n) => n + 1);
        }, RETRY_MS);
      };

      // Only while somebody is actually LOOKING. The document being visible is
      // not enough, because this pane stays mounted behind the Logs tab, and
      // this ping is the ONLY evidence the server has: without it the box is
      // held awake — and paid for — for a picture nobody has on screen.
      ping = setInterval(() => {
        if (!activeRef.current) return;
        if (document.visibilityState !== "visible") return;
        if (opened.socket.readyState !== WebSocket.OPEN) return;
        opened.socket.send(JSON.stringify({ type: "ping" }));
      }, WATCH_PING_MS);
    })();

    return () => {
      closed = true;
      if (ping) clearInterval(ping);
      if (retry) clearTimeout(retry);
      stream?.close();
    };
  }, [session, tokens, refresh, streamAttempt]);

  const setLeaseAction = useCallback(
    async (action: "acquire" | "resume") => {
      if (!tokens || !session) return;
      const mine = generation.current;
      setError(null);
      try {
        const outcome = await actOnHostedBrowserLease(tokens, { action });
        if (generation.current !== mine) return;
        setLease(outcome.lease);
        setHolding(outcome.yours);
        if (!outcome.took) {
          setError("Someone else is using this browser right now.");
          return;
        }
        // Taking control revokes every watcher the daemon had, including this
        // pane's own stream: it is reopened here rather than waited out.
        setStreamAttempt((n) => n + 1);
      } catch (cause) {
        if (generation.current !== mine) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [tokens, session],
  );

  // Keep a held lease alive. It expires into `parked` on purpose — a timer
  // running out is not evidence the private moment ended — and a person
  // mid-login should not have to re-take a browser they never let go of.
  useEffect(() => {
    if (!holding || !tokens) return;
    const timer = setInterval(() => {
      void actOnHostedBrowserLease(tokens, { action: "heartbeat" }).catch(
        () => {},
      );
    }, LEASE_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [holding, tokens]);

  // Hand the browser back when this tab goes away.
  //
  // Best-effort: `keepalive` lets the request outlive the page, but a hard
  // crash sends nothing — which is why a hold PARKS rather than freeing, and
  // why the server answers `yours` for a returning pane. Releasing here is the
  // difference between the agent carrying on at once and it waiting out a hold
  // nobody is on the other end of.
  useEffect(() => {
    if (!holding || !tokens) return;
    const release = () => {
      void actOnHostedBrowserLease(
        tokens,
        { action: "resume" },
        { keepalive: true },
      ).catch(() => {});
    };
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, [holding, tokens]);

  // One POST in flight, the rest queued and consecutive moves collapsed. One
  // forwarder per HOLD, not per session: whatever it has queued belonged to
  // the hold that queued it, so a hand-back or an expiry must retire it rather
  // than let its tail arrive under whoever holds the browser next.
  const forwarder = useMemo(() => {
    if (!tokens || !holding) return null;
    return createInputForwarder((events) =>
      sendHostedBrowserInput(tokens, { events }),
    );
  }, [tokens, holding]);
  useEffect(() => () => forwarder?.cancel(), [forwarder]);

  const send = useCallback(
    (events: BrowserInputEvent[]) => {
      if (!forwarder || !holding || events.length === 0) return;
      forwarder.push(events);
    },
    [forwarder, holding],
  );

  const placeholder = (() => {
    if (!projectId) {
      return (
        <PaneMessage dashed>
          <span data-testid="hosted-browser-no-project">
            Open a project to use its browser.
          </span>
        </PaneMessage>
      );
    }
    if (unavailable) {
      return (
        <PaneMessage dashed>
          <span data-testid="hosted-browser-unavailable">
            This project&apos;s cloud computer isn&apos;t reachable right now.
          </span>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        </PaneMessage>
      );
    }
    if (!session) {
      return (
        <PaneMessage dashed>
          <span data-testid="hosted-browser-idle">
            No browser is running on this computer yet.
          </span>
          <Button size="sm" disabled={busy} onClick={() => void open()}>
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

  const control: PaneControl = holding
    ? "you"
    : lease.state === "free" || lease.state === "unknown"
      ? "agent"
      : lease.holderKind === "script"
        ? "script"
        : "other";

  return (
    <BrowserPaneSurface
      frame={frame}
      holding={holding}
      control={control}
      // A lease somebody else holds is not one this pane may step over.
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
