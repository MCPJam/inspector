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
  /**
   * What the SOCKET last said, kept apart from `error`.
   *
   * The two have different owners and different lifetimes. `refresh()` clears
   * `error` on every successful session read — and a 4409 close triggers
   * exactly such a read, so the "somebody else has control" message set a tick
   * earlier was wiped before anyone saw it. The viewer got a dark pane, no
   * explanation, and a fresh flicker of it every three seconds. This one is
   * cleared by the thing that actually disproves it: a frame arriving.
   */
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  /** Bumped to re-open the frame socket after it was refused. */
  const [streamAttempt, setStreamAttempt] = useState(0);
  /**
   * CONSECUTIVE 4401s, not 4401s ever — and a REF, deliberately.
   *
   * Every reconnect re-runs the socket effect, so a counter declared inside it
   * resets on each attempt and the cap never binds: the pane would mint
   * tokens against the same refusal forever. Cleared when a FRAME arrives,
   * which is the only evidence an attempt actually worked — a socket that
   * merely opened proves nothing, because this server accepts the upgrade and
   * refuses inside it.
   */
  const tokenRetriesRef = useRef(0);

  const activeRef = useRef(active);
  activeRef.current = active;
  /**
   * The hold, readable from a cleanup that must not re-run when it changes.
   *
   * The teardown below has to know whether this pane still holds the browser,
   * but must fire only when the pane GOES AWAY — depending on `holding`
   * directly would send a second hand-back after every ordinary one.
   */
  const holdingRef = useRef(holding);
  holdingRef.current = holding;

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
    // Captured, not read from a ref: by the time this cleanup runs, a ref
    // assigned during render already holds the NEXT project's cache, and
    // releasing with that would name a different computer.
    const mine = tokens;
    generation.current += 1;
    setSession(null);
    setLease({ state: "unknown" });
    setHolding(false);
    setFrame(null);
    setError(null);
    setNotice(null);
    setUnavailable(null);
    tokenRetriesRef.current = 0;
    return () => {
      // HAND THE BROWSER BACK ON THE WAY OUT. `pagehide` covers the tab
      // closing; it does not cover this component being unmounted — which the
      // rail does on every engine switch — or the project changing under it.
      // Either left the lease held, and a held lease that stops being
      // heartbeaten PARKS rather than frees, on purpose. So the agent stayed
      // blocked on a browser nobody was watching, with no pane left that was
      // allowed to hand it back: only the holder may, and the holder was gone.
      if (!holdingRef.current || !mine) return;
      void actOnHostedBrowserLease(
        mine,
        { action: "resume" },
        { keepalive: true },
      ).catch(() => {});
    };
    // `tokens` changes only when `projectId` does, so this still runs once per
    // project — it is in the list because the cleanup closes over it.
  }, [projectId, tokens]);

  /**
   * Which read of THIS browser is the latest.
   *
   * `generation` tells one browser from another; it cannot tell two reads of
   * the same one apart. Two are easy to have in flight at once — the mount
   * read, the one a 4409 triggers, the one a tab switch triggers — and the
   * slower of them lands last, overwriting a newer lease with an older one.
   * The window is small and the answer it leaves is "somebody else has
   * control" over a browser that is free.
   */
  const readSerial = useRef(0);
  /**
   * Does this pane's idea of the lease predate something it could not see?
   *
   * A 4409 tells us somebody took the browser; NOTHING tells us they handed it
   * back. The pane reconnects every few seconds and eventually succeeds, but
   * `lease.state` is still whatever it was when they took it — so "Take
   * control" never comes back and the header goes on naming a holder who left,
   * until the tab is reloaded. A frame arriving after a refusal is the proof
   * the refusal is over, and the moment to ask again.
   */
  const leaseIsStale = useRef(false);

  /** Read the row without starting anything. */
  const refresh = useCallback(
    async (options: { ensure?: boolean } = {}) => {
      if (!tokens) return;
      const mine = generation.current;
      const serial = (readSerial.current += 1);
      try {
        const next = await fetchHostedBrowserSession(tokens, options);
        if (generation.current !== mine || readSerial.current !== serial)
          return;
        // BY IDENTITY, because the socket effect keys off this object.
        //
        // A fresh one for an unchanged row RECONNECTS, and it does so out of
        // band: the effect's cleanup cancels the backoff timer on its way
        // past. So the re-read after a 4409 — which is the read that finds
        // the lease still held — would come straight back to a server that
        // refuses it again, re-read again, and reconnect again, with the 3s
        // delay cancelled every single time. A held lease would become a hot
        // loop against the daemon for as long as somebody else is typing.
        setSession((prev) =>
          prev &&
          prev.bootId === next.bootId &&
          prev.contextMode === next.contextMode
            ? prev
            : { bootId: next.bootId, contextMode: next.contextMode },
        );
        setLease(next.lease);
        // The SERVER says whether the lease is this viewer's. Tracking "I
        // acquired it" here instead would forget across a reload and then lock
        // this pane out of a parked lease it still holds, since only the
        // holder may hand one back.
        setHolding(next.yours);
        setUnavailable(null);
        setError(null);
      } catch (cause) {
        if (generation.current !== mine || readSerial.current !== serial)
          return;
        if (cause instanceof HostedBrowserError && cause.status === 409) {
          // No browser on this computer yet — an offer, not a failure.
          setSession(null);
          setUnavailable(null);
          setError(null);
          return;
        }
        setUnavailable(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [tokens],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = useCallback(async () => {
    setBusy(true);
    // A new browser has no history for the last one's notice to describe.
    setNotice(null);
    leaseIsStale.current = false;
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
          if (parsed.type === "frame" && parsed.frame) {
            setFrame(parsed.frame);
            // The attempt worked: forgive the refusals that came before it,
            // and clear whatever the last close told the viewer, since the
            // picture is back and the message is no longer true.
            tokenRetriesRef.current = 0;
            setNotice(null);
            if (leaseIsStale.current) {
              // Frames are flowing again, so whoever was holding the browser
              // is not holding it any more. Nothing else says so.
              leaseIsStale.current = false;
              void refresh();
            }
          }
        } catch {
          // Not our protocol.
        }
      };
      // NOT reset on `onopen`, which is the trap this route lays. The server
      // accepts the upgrade and only then closes — it has to, because once an
      // upgrade is requested there is no HTTP status left to send — so a
      // REFUSED socket still fires `open` before its `close(4401)`. Resetting
      // there zeroed the counter on every refusal, the cap below could never
      // bind, and a token rejected for anything other than expiry (ownership
      // moved, the row's project changed) put the pane in a permanent
      // three-second loop of Convex mints and sandbox lookups for as long as
      // the tab stayed open. The unit test missed it because its socket double
      // never calls `onopen` at all.
      //
      // A FRAME is the evidence: it means the token was accepted, the lease
      // let us watch, and the daemon is streaming. Nothing else proves the
      // attempt worked.
      opened.socket.onclose = (event) => {
        if (closed) return;
        setFrame(null);
        if (event.code === CLOSE_LEASE_HELD) {
          // Somebody else has the browser, including a handoff that happened
          // while this socket was open — the daemon revokes mid-stream. NOT
          // terminal: the view has to come back when they hand it back, so
          // keep asking rather than latching an error nothing will clear.
          setNotice(
            "Somebody else has taken control of this browser. The view will resume when they hand it back.",
          );
          // Their hand-back arrives as nothing at all — see `leaseIsStale`.
          leaseIsStale.current = true;
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
          setNotice(
            "This view is no longer authorized. Reopen the pane to watch again.",
          );
          return;
        }
        if (event.code === CLOSE_NOT_FOUND) {
          // The browser stopped. Offer to open one rather than retrying at a
          // machine that has nothing to show — and drop whatever the last
          // close said, since "somebody else has control" over an offer to
          // start a browser is a sentence about a session that is gone.
          setSession(null);
          setHolding(false);
          setNotice(null);
          leaseIsStale.current = false;
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
      const mine = generation.current;
      // THE ANSWER MATTERS. A heartbeat can be refused — the lease expired
      // into `parked` and somebody else took it, or the browser relaunched —
      // and throwing that away left the pane offering input and a Hand back
      // against a lease the server no longer recognises. Every keystroke then
      // goes nowhere and the person cannot tell why.
      void actOnHostedBrowserLease(tokens, { action: "heartbeat" })
        .then((outcome) => {
          if (generation.current !== mine) return;
          setLease(outcome.lease);
          setHolding(outcome.yours);
        })
        .catch(() => {});
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
      error={notice ?? error}
      active={active}
    />
  );
}
