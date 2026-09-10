import { useBrowserWorkspaceEnabled } from "@/hooks/useComputersEnabled";
import {
  browserPageToolsKey,
  noteWebmcpStats,
  useBrowserPageToolsStore,
} from "@/stores/browser-page-tools-store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { PaneMessage } from "@/components/computer/PaneMessage";
import {
  BrowserPaneSurface,
  type PaneControl,
} from "@/components/browser/BrowserPaneSurface";
import { BrowserShell } from "@/components/browser/BrowserShell";
import { useBrowserSession } from "@/lib/browser-shell/use-browser-session";
import {
  paneInteractionAnchor,
  TAKEOVER_RETRY_NOTICE,
} from "../../../../shared/browser-pane-command";
import type { BrowserPaneCommand } from "../../../../shared/browser-pane-command";
import {
  PaneSettingsMenu,
  PaneControlBar,
  labelFor,
} from "@/components/browser/PaneControlBar";
import { BrowserPanel } from "@/components/computer/BrowserPanel";
import { BrowserProfileSaveButton } from "@/components/browser/BrowserProfileSaveButton";
import {
  createTierController,
  encoderTierFor,
  type QualityTier,
} from "@/lib/browser-pane/tier";
import {
  createInputForwarder,
  type BrowserInputEvent,
  type PaneFrame,
} from "@/lib/browser-pane/input";
import { paneFrameStats } from "@/lib/browser-pane/frame-stats";
import { createFrameWireReader } from "@/lib/browser-pane/frame-wire";
import {
  createPaneVideoDecoder,
  videoDecodeSupported,
  seqOfUnitTimestamp,
} from "@/lib/browser-pane/video-decoder";
import { captureBrowserPaneSessionSummary } from "@/lib/browser-pane/session-summary";
import {
  actOnHostedBrowserLease,
  fetchHostedBrowserState,
  reportHostedPaneViewport,
  sendHostedPaneCommand,
  createBrowserTokenCache,
  fetchHostedBrowserSession,
  fetchHostedBrowserProfileArchive,
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
/**
 * This box cannot encode video. Reconnect WITHOUT asking for it.
 *
 * Its own code because the answer differs from every other close: retrying the
 * request as-is asks a daemon that has already said it has no encoder for
 * H.264 again, forever, while the JPEG wire underneath works perfectly.
 */
const CLOSE_VIDEO_UNAVAILABLE = 4415;

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

/**
 * The tiers the hosted pane can actually offer.
 *
 * VNC is here and not on the local pane because it is the DESKTOP view — the
 * existing noVNC panel — which only a hosted box has. Offering a menu entry
 * that cannot work is worse than not offering it.
 */
const HOSTED_TIERS = ["auto", "sharp", "saver", "mjpeg", "vnc"] as const;

export function HostedBrowserBody({
  projectId,
  sessionId,
  mintToken,
  active = true,
}: {
  projectId: string | null;
  /** Durable logical browser session, when this pane belongs to a chat. */
  sessionId?: string;
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
  const workspaceEnabled = useBrowserWorkspaceEnabled();
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
  /**
   * The live socket and what it said it could do.
   *
   * A REF because the input forwarder must not be rebuilt on every reconnect —
   * rebuilding it mid-drag drops the queue — and because the `hello` that
   * answers "can this server take input on the socket?" arrives after the
   * forwarder already exists. A server that does not advertise `input` keeps
   * getting POSTs, which is how a new client talks to an old relay for one
   * release.
   */
  const socketRef = useRef<WebSocket | null>(null);
  const socketInputRef = useRef(false);
  /** The seq on screen when a gesture goes, for the input→paint sample. */
  const frameSeqRef = useRef(0);
  /**
   * Has video already failed for this session?
   *
   * A REF, and it survives reconnects on purpose: a decoder that gave up did so
   * because this browser cannot decode this stream, and asking again on the
   * next socket would produce the same three errors and the same fallback, a
   * few seconds later each time.
   */
  const videoRefusedRef = useRef(false);
  /** The latest round trip, for the tier controller's latency rule. */
  const rttRef = useRef<number | undefined>(undefined);
  /**
   * Which tab the box was last showing, for the "the agent switched" notice.
   *
   * A REF now, not state. It used to feed a read-only strip beside the picture
   * — the truncated `{id, url}` list the heartbeat carries, which is all the
   * pane could get — and the shell's own strip reads the complete list from
   * `/state` instead. What is still worth having from the heartbeat is its
   * SPEED: it arrives several times a second, so the notice about a tab the
   * agent just switched to shows up before the next reconcile. Nothing renders
   * the value, so nothing needs a re-render when it changes.
   */
  const activeTabRef = useRef<string | undefined>(undefined);
  const [tabNotice, setTabNotice] = useState<string | null>(null);
  /**
   * Quality, and who decided it.
   *
   * The CONTROLLER lives in a ref because it is fed from the socket handler on
   * every `stats` message, and rebuilding it per render would erase the
   * hysteresis that stops the tier oscillating.
   */
  const tierController = useRef(createTierController());
  const [tier, setTier] = useState<QualityTier>("auto");
  const [tierPreference, setTierPreference] = useState<QualityTier>("auto");
  /**
   * The tier, readable from the socket effect without re-running it.
   *
   * The effect owns a live connection; re-running it on a tier change would
   * drop the picture. Only the two tiers that change the TRANSPORT need a
   * reconnect, and those bump `streamAttempt` explicitly.
   */
  const tierRef = useRef<QualityTier>(tier);
  tierRef.current = tier;

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
    /** Built on the first access unit; null on a stream that stays JPEG. */
    let video: ReturnType<typeof createPaneVideoDecoder> | null = null;
    /**
     * Record what the box says is on screen, and say so when it moves.
     *
     * Only when it MOVES, and only after a first reading: naming the tab a
     * person just opened the pane on would be a notification about nothing.
     */
    const noteTabs = (next?: {
      active?: string;
      list?: Array<{ id: string; url: string }>;
    }) => {
      if (closed || !next) return;
      const previous = activeTabRef.current;
      activeTabRef.current = next.active;
      if (!previous || !next.active || previous === next.active) return;
      const tab = next.list?.find((entry) => entry.id === next.active);
      // The HOST, like the strip beside it — a path carries reset tokens,
      // share links and account ids, and this notice is the one thing on
      // screen large enough for somebody at the next desk to read.
      setTabNotice(
        `The agent switched to ${tab ? labelFor(tab) : next.active}`,
      );
    };
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

      // The daemon's own bytes, and video when this browser can decode it. A
      // relay too old to negotiate either ignores the parameters and keeps
      // sending JSON, which the handler below still reads.
      // `mjpeg` is the JPEG path FORCED: what somebody picks when video looks
      // wrong to them and they want the transport they can reason about.
      const wantsVideo =
        videoDecodeSupported() &&
        !videoRefusedRef.current &&
        tierRef.current !== "mjpeg";
      const opened = openHostedBrowserFrameStream({
        token,
        wire: "binary",
        ...(wantsVideo ? { codec: "h264" as const } : {}),
      });
      stream = opened;
      /**
       * The video decoder, built on the FIRST access unit rather than up front.
       *
       * A relay that agreed to `h264` still sends JPEG until the encoder has
       * something to say, and a decoder constructed for a stream that turns
       * out to be JPEG is a `VideoDecoder` held open for nothing.
       */
      /**
       * The access unit currently being decoded.
       *
       * A REF, not the closure's `unit`: the decoder is built on the FIRST
       * unit and its `onFrame` lives as long as the socket, so closing over
       * that one made every later picture report the first frame's sequence,
       * timestamp and geometry — a pane whose clicks map through a rectangle
       * from ten minutes ago.
       */
      const units = new Map<
        number,
        {
          deviceWidth: number;
          deviceHeight: number;
          scale: number;
          relayTs: number;
          seq: number;
        }
      >();
      /**
       * A LEAK GUARD, not a policy.
       *
       * What actually retires an entry is the paint: everything at or below
       * the sequence on screen can never be claimed again. This is only for
       * units a decoder swallowed without ever outputting, and it is set where
       * no working decoder reaches — eight seconds of backlog at thirty frames
       * a second. Evicting on a small count instead was a freeze waiting to
       * happen: a decoder that fell behind by more than the count would have
       * every one of its outputs miss, and a pane whose lookups all miss draws
       * nothing at all.
       */
      const UNITS_MAX = 240;
      /** The newest sequence PAINTED, so a slow decode cannot go backwards. */
      let paintedSeq = -1;
      const paintVideo = (unit: {
        key: boolean;
        au: Uint8Array;
        deviceWidth: number;
        deviceHeight: number;
        scale: number;
        relayTs: number;
        seq: number;
        bytes: number;
      }) => {
        if (closed) return;
        paneFrameStats.noteTransport("h264");
        paneFrameStats.noteFrameArrived({ bytes: unit.bytes });
        // BY SEQUENCE, not "the newest". The decoder is asynchronous and can
        // hold several units at once, so by the time it outputs the picture
        // for unit N the wire has usually delivered N+1 — and reading a
        // mutable `latest` at output time gave that picture the NEXT unit's
        // geometry and timestamp. Which is a pane whose clicks map through the
        // wrong rectangle for as long as the sizes differ.
        units.set(unit.seq, {
          deviceWidth: unit.deviceWidth,
          deviceHeight: unit.deviceHeight,
          scale: unit.scale,
          relayTs: unit.relayTs,
          seq: unit.seq,
        });
        // Insertion order IS sequence order: the wire delivers in order and a
        // repeat of a sequence overwrites rather than appends. So everything
        // up to what is on screen is at the front, and everything at or below
        // it is a picture that has already been drawn or superseded.
        for (const seq of units.keys()) {
          if (seq > paintedSeq) break;
          units.delete(seq);
        }
        while (units.size > UNITS_MAX) {
          const oldest = units.keys().next();
          if (oldest.done) break;
          units.delete(oldest.value);
        }
        // A picture arriving is the same proof of life a JPEG is: the token
        // works, the lease is ours, and whatever the last close said is over.
        tokenRetriesRef.current = 0;
        setNotice(null);
        if (leaseIsStale.current) {
          // Frames are flowing again, so whoever was holding the browser is
          // not holding it any more — and nothing else says so. The JPEG path
          // has always re-read here; the video path cleared the flag and left
          // the header and the take-control button describing the old holder
          // until something else happened to read the lease.
          leaseIsStale.current = false;
          void refresh();
        }
        if (!video) {
          video = createPaneVideoDecoder({
            onFrame: (decoded) => {
              // The unit this picture belongs to, found by the timestamp the
              // decoder carried through from the chunk (`seq * 1_000`).
              const at = units.get(seqOfUnitTimestamp(decoded.timestamp));
              if (at) units.delete(at.seq);
              if (closed || !at) {
                decoded.close();
                return;
              }
              frameSeqRef.current = at.seq;
              // The pane converts to a bitmap it owns — the same shape every
              // other wire produces, which is what keeps the surface free of
              // codec knowledge. The `VideoFrame` is closed only once that
              // conversion has finished reading it.
              void createImageBitmap(decoded)
                .then((bitmap) => {
                  // Decodes can finish out of order. An older picture painted
                  // over a newer one is a visibly stale page whose clicks map
                  // through the wrong rectangle.
                  if (closed || at.seq <= paintedSeq) {
                    bitmap.close();
                    return;
                  }
                  paintedSeq = at.seq;
                  // The pane releases each bitmap as the next replaces it; a
                  // frame that never reached the surface has no successor to
                  // do it.
                  lastBitmap?.close();
                  lastBitmap = bitmap;
                  setFrame({
                    bitmap,
                    deviceWidth: at.deviceWidth,
                    deviceHeight: at.deviceHeight,
                    scale: at.scale,
                    ts: at.relayTs,
                    relayTs: at.relayTs,
                    seq: at.seq,
                  });
                })
                .catch(() => {
                  // One picture. The next one replaces it.
                })
                .finally(() => {
                  decoded.close();
                });
            },
            onGiveUp: () => {
              // Video is not going to work for this session. Reconnecting
              // without asking for it puts the pane back on JPEG, which is the
              // same fallback a browser with no `VideoDecoder` takes.
              video = null;
              videoRefusedRef.current = true;
              opened.close();
            },
          });
        }
        video.push({ key: unit.key, au: unit.au, seq: unit.seq });
      };

      wire = createFrameWireReader(
        {
          onVideo: paintVideo,
          onFrame: (decoded) => {
            if (closed) return;
            paneFrameStats.noteTransport("jpeg-binary");
            paneFrameStats.noteFrameArrived({ bytes: decoded.bytes });
            frameSeqRef.current = decoded.seq;
            tokenRetriesRef.current = 0;
            setNotice(null);
            if (leaseIsStale.current) {
              leaseIsStale.current = false;
              void refresh();
            }
            // React can coalesce two `setFrame` calls into one render, and the
            // surface only ever releases a frame it PAINTED — so a picture that
            // was superseded before the commit has nobody to free it.
            lastBitmap?.close();
            lastBitmap = decoded.bitmap;
            setFrame({
              bitmap: decoded.bitmap,
              decodeMs: decoded.decodeMs,
              deviceWidth: decoded.deviceWidth,
              deviceHeight: decoded.deviceHeight,
              scale: decoded.scale,
              ts: decoded.relayTs,
              relayTs: decoded.relayTs,
              seq: decoded.seq,
            });
          },
          onHeartbeat: (daemon) => {
            // MERGED, not assigned: the relay's own counters arrive on the
            // `stats` message and the daemon's ride the frame wire, at different
            // cadences. Writing the whole object from either would blank the
            // other's numbers between ticks.
            if (daemon) paneFrameStats.noteDaemonStats(daemon as never);
            noteTabs(
              (daemon as { tabs?: { active?: string } } | undefined)?.tabs,
            );
            // The page's tools, as a CHANGE SIGNAL. It rides a beat that is
            // already flowing, so the Tools pane becomes live without a second
            // stream and without polling a page-touching observation.
            noteWebmcpStats(
              browserPageToolsKey(projectId, "hosted"),
              daemon as never,
              session.bootId,
            );
          },
          onFatal: () => {
            // A reader that has lost its place in a byte stream can never find
            // it again, so the connection goes rather than the record.
            opened.close();
          },
        },
        { video: wantsVideo },
      );
      openedSocket = opened.socket;
      socketRef.current = opened.socket;
      // Until this socket's own `hello` says otherwise. A reconnect must not
      // inherit the previous connection's answer.
      socketInputRef.current = false;
      paneFrameStats.noteTransport("jpeg-json");
      opened.socket.onmessage = (event) => {
        // The pixel path is bytes and the control path is text, on one socket.
        // Branching on the DATA rather than on what `hello` promised keeps a
        // pane correct against a relay that answered `json` and a relay that
        // answered `binary` alike.
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
            const ack = parsed as unknown as {
              seq?: number;
              refused?: string;
            };
            if (typeof ack.seq === "number")
              paneFrameStats.noteInputAck(ack.seq);
            // A REFUSAL IS THE SERVER SAYING THIS PANE DOES NOT HAVE CONTROL.
            // Recording only the latency left the pane believing it did —
            // still forwarding keys and clicks into a page that discards every
            // one, with nothing on screen to say why.
            if (
              ack.refused === "lease_held" ||
              ack.refused === "lease_parked"
            ) {
              setHolding(false);
              setNotice(
                "Somebody else has taken control of this browser. The view will resume when they hand it back.",
              );
              leaseIsStale.current = true;
              void refresh();
            } else if (ack.refused === "lease_required") {
              setHolding(false);
            }
            return;
          }
          if (parsed.type === "pong") {
            // The pane's own stamp, echoed. One clock, so the subtraction is
            // a round trip rather than the drift between two machines.
            if (typeof parsed.t === "number") {
              const rtt = Date.now() - parsed.t;
              paneFrameStats.noteRtt(rtt);
              // Kept for the tier controller, which reads loss AND latency: a
              // link that drops nothing but answers in half a second is still
              // a link somebody is waiting on, and without this the whole
              // latency half of the auto rule never fired.
              rttRef.current = rtt;
            }
            return;
          }
          if (parsed.type === "stats") {
            // ALSO HERE, not only on the frame wire: this engine's relay
            // consumes the daemon's heartbeat itself and re-emits its own
            // `stats`, so on a stream with no video the frame-wire handler
            // above never fires at all.
            noteWebmcpStats(
              browserPageToolsKey(projectId, "hosted"),
              parsed.daemon as never,
              session.bootId,
            );
            // The tier decision is made from what the RELAY saw, not from what
            // this pane painted: a pane that dropped a frame because a tab was
            // hidden is not a link that cannot carry the stream.
            const before = tierController.current.current();
            const next = tierController.current.observe({
              ...(parsed.framesIn !== undefined
                ? { framesIn: parsed.framesIn }
                : {}),
              ...(parsed.dropped !== undefined
                ? { dropped: parsed.dropped }
                : {}),
              ...(rttRef.current !== undefined ? { rtt: rttRef.current } : {}),
              ...(typeof (parsed.daemon as { encoderIdle?: boolean })
                ?.encoderIdle === "boolean"
                ? {
                    encoderIdle: (parsed.daemon as { encoderIdle: boolean })
                      .encoderIdle,
                  }
                : {}),
            });
            setTier(next);
            paneFrameStats.noteTier(next);
            // TELL THE DAEMON. Auto used to move only the pane's own state,
            // so a viewer on a link that could not carry the stream was
            // labelled "Data saver" while the encoder went on producing
            // exactly the bitrate that was being dropped.
            if (next !== before) {
              const socket = socketRef.current;
              if (socket?.readyState === WebSocket.OPEN) {
                socket.send(
                  JSON.stringify({
                    type: "quality",
                    tier: encoderTierFor(next),
                  }),
                );
              }
            }
            // THE TAB STRIP LIVES HERE ON HOSTED. The relay consumes the
            // daemon's heartbeat to build this message, so the frame wire's
            // own `onHeartbeat` never fires on this engine — and the strip,
            // which only hosted has, never updated once.
            noteTabs(
              (parsed.daemon as { tabs?: { active?: string } } | undefined)
                ?.tabs,
            );
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
        if (event.code === CLOSE_VIDEO_UNAVAILABLE) {
          // A box with no ffmpeg, or an encoder that failed to spawn. The same
          // fallback a browser with no `VideoDecoder` takes, and the same one
          // the daemon's own `video_unavailable` was always meant to trigger.
          videoRefusedRef.current = true;
          retry = setTimeout(() => {
            if (!closed) setStreamAttempt((n) => n + 1);
          }, RETRY_MS);
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
        // Stamped, so the pong measures a round trip. A server too old to echo
        // `t` simply produces no rtt sample rather than a wrong one.
        opened.socket.send(JSON.stringify({ type: "ping", t: Date.now() }));
      }, WATCH_PING_MS);
    })();

    return () => {
      closed = true;
      wire?.close();
      video?.close();
      // The pane releases each bitmap as the next one replaces it; the LAST
      // one has no successor, and this is the thing that knows the stream is
      // over.
      lastBitmap?.close();
      if (ping) clearInterval(ping);
      if (retry) clearTimeout(retry);
      if (socketRef.current === openedSocket) {
        socketRef.current = null;
        socketInputRef.current = false;
      }
      stream?.close();
    };
  }, [session, tokens, refresh, streamAttempt]);

  // THE SIGNAL DIES WITH THE PANE. It describes the browser this pane was
  // watching; once the pane is gone (or the project changes under it) the
  // Tools pane must not keep answering for a stream nobody is reading. Its own
  // effect, keyed on the project alone, so a reconnect does not clear it — a
  // cleared key comes back on the next beat as a fresh epoch, which would
  // refetch the page's tools on every reconnect for nothing.
  useEffect(() => {
    const key = browserPageToolsKey(projectId, "hosted");
    return () => useBrowserPageToolsStore.getState().clear(key);
  }, [projectId]);

  /**
   * Acquire or hand back, and say whether it landed.
   *
   * Returns a boolean because the TAKEOVER path needs the answer: a click that
   * did not get the lease must not then be forwarded as input. One function
   * rather than two call sites, so the generation guard cannot be skipped by
   * the newer one — a lease belongs to ONE browser, and an answer arriving
   * after the pane has moved to another would show control of something nobody
   * is watching.
   */
  const setLeaseAction = useCallback(
    async (action: "acquire" | "resume"): Promise<boolean> => {
      if (!tokens || !session) return false;
      const mine = generation.current;
      setError(null);
      try {
        const outcome = await actOnHostedBrowserLease(tokens, { action });
        if (generation.current !== mine) return false;
        setLease(outcome.lease);
        setHolding(outcome.yours);
        if (!outcome.took) {
          setError("Someone else is using this browser right now.");
          return false;
        }
        // Taking control revokes every watcher the daemon had, including this
        // pane's own stream: it is reopened here rather than waited out.
        setStreamAttempt((n) => n + 1);
        return true;
      } catch (cause) {
        if (generation.current !== mine) return false;
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
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
  // The tab toast is transient: it says something HAPPENED, and a message that
  // stayed would keep describing a switch that is minutes old.
  useEffect(() => {
    if (!tabNotice) return;
    const timer = setTimeout(() => setTabNotice(null), 4_000);
    return () => clearTimeout(timer);
  }, [tabNotice]);

  // One analytics event per pane, on the way out — see `session-summary`.
  useEffect(() => () => captureBrowserPaneSessionSummary("hosted"), []);

  /**
   * Will the next batch go on the SOCKET?
   *
   * One predicate for two decisions that must agree: which transport the send
   * callback picks, and whether the forwarder has to serialize. Two spellings
   * of the same question drifted, and the drift was silent — concurrent POSTs
   * on a socket that had merely dropped.
   */
  const socketSendable = useCallback(
    () =>
      socketInputRef.current &&
      socketRef.current?.readyState === WebSocket.OPEN,
    [],
  );

  const exportProfile = useCallback(async () => {
    if (!tokens) throw new Error("The hosted browser is not ready yet.");
    return fetchHostedBrowserProfileArchive(tokens);
  }, [tokens]);

  const forwarder = useMemo(() => {
    if (!tokens || !holding) return null;
    return createInputForwarder(
      (events, seq) => {
        paneFrameStats.noteInputSent(frameSeqRef.current, seq);
        if (socketSendable()) {
          // Ordered by the socket, so nothing here waits — see the
          // forwarder's docstring. A refusal comes back as an `input_ack`,
          // never a close.
          socketRef.current!.send(
            JSON.stringify({ type: "input", seq, events }),
          );
          return;
        }
        // One release of fallback: an old relay that did not advertise
        // `input`, or a socket that is between reconnects.
        return sendHostedBrowserInput(tokens, { events });
      },
      // Only the POST needs ordering imposed on it; concurrent POSTs arrive in
      // whatever order the network felt like.
      // The predicate has to match the TRANSPORT the callback actually
      // chooses, not merely the capability: the send falls back to POST
      // whenever the socket is not open, and a `serialize` that only read the
      // flag let two POSTs travel at once — an unordered drag lands where
      // nobody aimed, and an unordered press/release leaves a button held.
      { serialize: () => !socketSendable() },
    );
  }, [tokens, holding, socketSendable]);
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

  /**
   * The shell's transport, for this engine.
   *
   * Every call carries the token cache rather than a holder: the server reads
   * the holder off the token's claims, exactly as `/input` and `/lease` do, so
   * a holder this client could name would let anyone who echoed the right id
   * drive somebody else's session.
   */
  const shellTransport = useMemo(() => {
    if (!tokens || !session) return null;
    return {
      readState: () => fetchHostedBrowserState(tokens),
      sendCommand: (args: {
        command: BrowserPaneCommand;
        commandId?: string;
      }) => sendHostedPaneCommand(tokens, args),
      reportViewport: (size: { width: number; height: number }) =>
        reportHostedPaneViewport(tokens, { ...size, policy: "followPane" }),
      resume: async () => {
        await setLeaseAction("resume");
      },
    };
  }, [tokens, session, setLeaseAction]);

  useEffect(() => {
    if (!workspaceEnabled && tokens && session)
      void reportHostedPaneViewport(tokens, {
        width: 1024,
        height: 768,
        policy: "fixed",
      });
  }, [workspaceEnabled, tokens, session?.bootId]);

  const shell = useBrowserSession({
    transport: workspaceEnabled ? shellTransport : null,
    // The hosted holder is the authenticated user, which this client never
    // sees. `holding` is passed to the shell explicitly instead, so it never
    // has to guess from an id it does not have.
    holderId: null,
    active,
  });

  const [takeoverNotice, setTakeoverNotice] = useState<string | null>(null);
  const takingRef = useRef(false);
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;
  const takeover = useCallback(
    async (events: BrowserInputEvent[]) => {
      if (!tokens || takingRef.current) return;
      const originalTokens = tokens;
      const anchor = paneInteractionAnchor(shell.state, session?.bootId);
      takingRef.current = true;
      try {
        if (
          !(await setLeaseAction("acquire")) ||
          tokensRef.current !== originalTokens
        )
          return;
        if (!anchor) {
          setTakeoverNotice(TAKEOVER_RETRY_NOTICE);
          return;
        }
        await sendHostedBrowserInput(originalTokens, { events, anchor });
        setTakeoverNotice(null);
      } catch {
        setTakeoverNotice(TAKEOVER_RETRY_NOTICE);
      } finally {
        takingRef.current = false;
      }
    },
    [tokens, session?.bootId, setLeaseAction, shell.state],
  );

  // The stats overlay's flag, which the take-control bar used to own.
  const [statsOpen, setStatsOpen] = useState(() => paneFrameStats.enabled());
  const onStatsToggle = useCallback((next: boolean) => {
    paneFrameStats.setEnabled(next);
    setStatsOpen(next);
  }, []);

  // The DESKTOP view, not the page: `BrowserPanel` proxies RFB and shows the
  // window manager, dialogs and popups. It is the honest answer to "the new
  // viewer is not working for me", and it only exists for a hosted box.
  if (tier === "vnc" && projectId) {
    return (
      <>
        <PaneControlBar
          control={control}
          statsOpen={false}
          onToggleStats={() => {}}
          tier={tierPreference}
          tiers={HOSTED_TIERS}
          onTier={(next) => {
            setTierPreference(next);
            const resolved = tierController.current.setPreference(next);
            setTier(resolved);
            tierRef.current = resolved;
            setStreamAttempt((n) => n + 1);
          }}
        />
        <div className="min-h-0 flex-1 px-3 pb-3">
          <BrowserPanel projectId={projectId} sessionId={sessionId} />
        </div>
      </>
    );
  }

  const onTier = (next: QualityTier) => {
    setTierPreference(next);
    const resolved = tierController.current.setPreference(next);
    const wasVideo = tierRef.current !== "mjpeg" && tierRef.current !== "vnc";
    const isVideo = resolved !== "mjpeg" && resolved !== "vnc";
    setTier(resolved);
    tierRef.current = resolved;
    paneFrameStats.noteTier(resolved);
    // Only a change of TRANSPORT needs a new socket. Reconnecting for a
    // bitrate change would drop the picture to buy nothing.
    if (wasVideo !== isVideo) setStreamAttempt((n) => n + 1);
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      // The daemon re-encodes at the new tier, which restarts ffmpeg and
      // produces the fresh keyframe every watcher needs. A relay too old
      // to understand this ignores it, and the tier stays a client-side
      // preference — which is still the right picture, just not a cheaper
      // one.
      socket.send(
        JSON.stringify({
          type: "quality",
          tier: encoderTierFor(resolved),
        }),
      );
    }
  };

  return (
    <BrowserShell
      enabled={workspaceEnabled}
      state={shell.state}
      holderId={null}
      // THIS engine's lease, not the shell's polled copy: the hosted body
      // learns about its own acquire the moment it lands, and the shell's
      // reconcile is a beat behind. @see BrowserShellProps.control
      holding={holding}
      control={{
        kind:
          control === "you"
            ? "human"
            : control === "script"
              ? "script"
              : control === "other"
                ? "human"
                : "agent",
        ...(lease.state === "parked" ? { parked: true } : {}),
      }}
      onCommand={shell.run}
      {...(session && holding ? { onResumeAgent: shell.resume } : {})}
      resuming={shell.resuming}
      onViewportMeasured={shell.reportViewport}
      // Not just "is there a browser": an engine too old to answer pane
      // commands has a perfectly real session, and controls that look live
      // and swallow every click read as broken rather than old.
      ready={!!session && shell.supported}
      // `notice` is the socket's lease-handoff message — somebody took the
      // browser, somebody handed it back. That is a STATUS, and the shell
      // renders notices as a polite live region while errors are static
      // destructive text: routed through `error` it was announced to nobody
      // and drawn as a failure.
      notice={takeoverNotice ?? notice ?? shell.notice ?? tabNotice}
      error={error ?? shell.error}
      {...(placeholder ? { placeholder } : {})}
      trailing={
        <>
          {session && sessionId ? (
            <BrowserProfileSaveButton
              projectId={projectId ?? ""}
              exportArchive={exportProfile}
              disabled={holding || busy}
            />
          ) : null}
          <PaneSettingsMenu
            statsOpen={statsOpen}
            onToggleStats={onStatsToggle}
            tier={tierPreference}
            tiers={HOSTED_TIERS}
            onTier={onTier}
          />
        </>
      }
    >
      <BrowserPaneSurface
        frame={frame}
        authority={{ kind: "lease", holding }}
        control={control}
        // NO take-control button. Using the browser is what takes it now, and
        // the shell's second row already says who is driving.
        chrome={workspaceEnabled ? "none" : "bar"}
        // The shell's menu owns this now; the surface draws it.
        statsOpen={workspaceEnabled ? statsOpen : undefined}
        onInput={send}
        onTakeoverInput={workspaceEnabled ? takeover : undefined}
        onTakeControl={
          !workspaceEnabled && session && !holding && lease.state === "free"
            ? () => void setLeaseAction("acquire")
            : undefined
        }
        onHandBack={
          !workspaceEnabled && session && holding
            ? () => void setLeaseAction("resume")
            : undefined
        }
        active={active}
        engine="hosted"
      />
    </BrowserShell>
  );
}
