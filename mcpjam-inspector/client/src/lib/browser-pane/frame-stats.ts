/**
 * Glass-to-glass measurement for a viewport stream. DARK BY DEFAULT.
 *
 * "Feels laggy" is not a number, and every change to this pipeline — the
 * transport, the throttle floor, the input batching, the codec — trades one
 * cost for another. These are the numbers that say whether a change helped:
 *
 *   capture→paint       the paint, minus the RELAY's stamp on the frame. Not
 *                       the sandbox's `ts`: the daemon's clock and the
 *                       viewer's are different machines on the hosted path, so
 *                       subtracting one from the other measures clock drift
 *                       and calls it latency. The relay is the last hop the
 *                       pane can honestly compare itself against, because it
 *                       is the hop the pane pings.
 *   input→visible paint the moment a gesture was sent, to the paint of the
 *                       first frame whose `seq` is newer than the one on
 *                       screen when it went. The repeatable wheel/keystroke
 *                       echo number, and what the rate and batching work moves.
 *   input→ack           the same gesture, to the relay's `input_ack`. Splits
 *                       "the input path is slow" from "the page did not
 *                       repaint", which the paint number alone cannot.
 *   rtt                 a pane-stamped ping echoed back untouched, so the whole
 *                       measurement lives on one clock.
 *
 * It lived in `lib/webmcp-inspector/frame-stats.ts` until the browser pane
 * needed the same numbers. That module now holds one INSTANCE of this, under
 * its own flag and its own globals, so its callers and its tests did not move.
 *
 * The `localStorage` flag decides what an instance does with it. On the WebMCP
 * inspector's instance it gates the whole mechanism, so every function is an
 * immediate return until somebody turns it on. On the browser pane's it gates
 * only the OVERLAY (`alwaysRecord`), because the session summary those samples
 * feed has to describe every viewer and not just the ones who went looking for
 * a debugging switch. Either way this sits in the paint path, so it costs a
 * boolean check and a bounded array push per frame and nothing else.
 */

/** Enough for ~30s of interaction at 60fps; oldest fall off. */
const MAX_SAMPLES = 2_000;
/** Inputs that never saw a newer frame — a page that simply did not repaint. */
const INPUT_TIMEOUT_MS = 3_000;
/** The window fps and kbps describe. Long enough to be stable, short enough to move. */
const RATE_WINDOW_MS = 3_000;

/**
 * Which transport the pane's pixels are arriving on.
 *
 * Recorded so the percentiles can be SPLIT by it. A p95 that mixes h264 frames
 * with polled screenshots describes neither, and the number people actually
 * want out of this — "did the transport change help?" — is precisely a
 * comparison between two of them.
 *
 * The first four are the WebMCP inspector's ladder, kept so its report shape is
 * unchanged; the rest are the browser pane's wire formats.
 *
 * `native` is the absence of one — an Electron `WebContentsView` parented into
 * the app's own window, where there is no encode, no socket and no decode.
 * Recorded anyway, and that is the point of this wave: "the pane feels like a
 * local window" is only a claim until the report says which transport drew it.
 */
export type FrameTransportRung =
  | "ws"
  | "none"
  | "jpeg-json"
  | "jpeg-binary"
  | "h264"
  | "native";

interface Sample {
  v: number;
  rung: FrameTransportRung;
}

export interface FrameStatsBucket {
  n: number;
  p50?: number;
  p95?: number;
}

export interface FrameStatsReport {
  captureToPaint: FrameStatsBucket;
  inputToPaint: FrameStatsBucket;
  inputToAck: FrameStatsBucket;
  rtt: FrameStatsBucket;
  decode: FrameStatsBucket;
  /**
   * The same capture→paint samples, split by the transport that carried them.
   *
   * Only rungs with samples appear, so a session that never left one transport
   * reports one bucket rather than seven mostly-empty ones — and the top-level
   * figures above are unchanged, because they are what every existing reader
   * of this report already asks for.
   */
  byTransport: Partial<Record<FrameTransportRung, FrameStatsBucket>>;
}

/** What the overlay draws: instantaneous, not cumulative. */
export interface FrameStatsLive {
  transport: FrameTransportRung;
  tier: string;
  engine: string;
  width: number;
  height: number;
  fps: number;
  kbps: number;
  rtt?: number;
  captureToPaintP50?: number;
  inputToPaintP50?: number;
  inputToPaintP95?: number;
  framesPainted: number;
  /** What the RELAY said about its own side of the stream. */
  relay?: {
    framesIn: number;
    framesOut?: number;
    bytes: number;
    dropped: number;
    subscribers: number;
    daemon?: {
      framesIn?: number;
      dropped?: { dedupe?: number; oversize?: number; pacer?: number };
      subscribers?: number;
      encoderIdle?: boolean;
    };
  };
}

export interface FrameStatsOptions {
  /** The `localStorage` key that shows this instance's overlay. */
  flag: string;
  /** `window.<name>()` prints the report; `<name>Reset()` clears it. */
  globalName?: string;
  /**
   * Record even with the flag unset, so the aggregate this feeds is not a
   * survey of people who happened to set a `localStorage` key.
   *
   * The flag then decides only whether the OVERLAY is drawn. Recording costs a
   * few bounded array pushes per frame in the paint path and nothing else —
   * the percentiles are computed on read.
   */
  alwaysRecord?: boolean;
  now?: () => number;
}

export interface FrameStats {
  /** Is the OVERLAY on? Recording may be on regardless — see `alwaysRecord`. */
  enabled(): boolean;
  /** Turn the overlay on or off from the UI, persisting the choice. */
  setEnabled(next: boolean): void;
  noteTransport(rung: FrameTransportRung): void;
  noteTier(tier: string): void;
  noteEngine(engine: string): void;
  noteRtt(ms: number): void;
  /** A frame arrived on the wire. Feeds fps and kbps; not a paint. */
  noteFrameArrived(args: { bytes: number }): void;
  notePainted(frame: {
    /** The relay's stamp. Preferred; `ts` is the fallback for loopback callers. */
    relayTs?: number;
    ts?: number;
    /**
     * Absent for a polled screenshot, which has no sequence to be newer THAN.
     *
     * Only the input echo needs it, and that number is one the poll cannot
     * honestly produce: at a fixed once-a-second cadence, "time from gesture
     * to the next paint" measures the poll interval rather than the input
     * path. Capture-to-paint is unaffected — it is a property of the picture,
     * not of the sequence.
     */
    seq?: number;
    rung?: FrameTransportRung;
    /** How long decode + draw took, when the pane measured it. */
    decodeMs?: number;
    width?: number;
    height?: number;
  }): void;
  /** A gesture left the client, with the seq on screen and its own id. */
  noteInputSent(afterSeq: number, seq?: number): void;
  /** The relay acknowledged that gesture. */
  noteInputAck(seq: number): void;
  noteRelayStats(stats: FrameStatsLive["relay"]): void;
  /**
   * Just the DAEMON's half, when it arrived on the frame wire rather than in
   * the relay's `stats` message.
   *
   * Merged rather than assigned: the relay's own counters and the daemon's
   * arrive on different paths at different cadences, and writing the whole
   * object from either one would blank the other's numbers between ticks.
   */
  noteDaemonStats(daemon: NonNullable<FrameStatsLive["relay"]>["daemon"]): void;
  report(): FrameStatsReport;
  live(): FrameStatsLive;
  reset(): void;
  /** Test seam: the flag is read once and cached for the tab's lifetime. */
  resetFlagForTests(): void;
}

export function createFrameStats(options: FrameStatsOptions): FrameStats {
  const now = options.now ?? (() => Date.now());
  let enabled: boolean | undefined;
  let installed = false;
  let currentRung: FrameTransportRung = "none";
  let tier = "auto";
  let engine = "";
  let width = 0;
  let height = 0;
  let framesPainted = 0;
  let relay: FrameStatsLive["relay"];

  const captureToPaint: Sample[] = [];
  const inputToPaint: Sample[] = [];
  const inputToAck: Sample[] = [];
  const rtt: Sample[] = [];
  const decode: Sample[] = [];
  /** Gestures still waiting for the first frame that postdates them. */
  let awaitingPaint: Array<{ sentAt: number; afterSeq: number }> = [];
  /** Gestures still waiting for their ack, by the seq the client stamped. */
  let awaitingAck = new Map<number, number>();
  /** Arrivals inside the rate window: fps and kbps, not a running total. */
  let arrivals: Array<{ at: number; bytes: number }> = [];

  function isEnabled(): boolean {
    if (enabled === undefined) {
      try {
        enabled = localStorage.getItem(options.flag) !== null;
      } catch {
        // Private mode, or a storage-less embedding.
        enabled = false;
      }
      if (enabled) install();
    }
    return enabled;
  }

  /**
   * Should this call record?
   *
   * Split from `isEnabled` because the flag means two different things on the
   * two instances that exist. On the WebMCP inspector's it gates the whole
   * mechanism, which is what its callers and its tests pin. On the browser
   * pane's it gates only the overlay, because the session summary it feeds has
   * to describe everybody's stream and not just those of the people who went
   * looking for a debugging switch.
   */
  function isRecording(): boolean {
    if (!options.alwaysRecord) return isEnabled();
    if (!installed) install();
    return true;
  }

  function push(into: Sample[], value: number, rung = currentRung): void {
    if (!Number.isFinite(value)) return;
    into.push({ v: value, rung });
    if (into.length > MAX_SAMPLES) into.splice(0, into.length - MAX_SAMPLES);
  }

  function trimRates(at: number): void {
    const floor = at - RATE_WINDOW_MS;
    if (arrivals.length > 0 && arrivals[0]!.at >= floor) return;
    arrivals = arrivals.filter((entry) => entry.at >= floor);
  }

  function install(): void {
    installed = true;
    if (typeof window === "undefined" || !options.globalName) return;
    const scope = window as unknown as Record<string, unknown>;
    scope[options.globalName] = () => api.report();
    scope[`${options.globalName}Reset`] = () => api.reset();
  }

  const api: FrameStats = {
    enabled: isEnabled,
    setEnabled(next) {
      try {
        if (next) localStorage.setItem(options.flag, "1");
        else localStorage.removeItem(options.flag);
      } catch {
        // Storage refused; the in-memory flag below still takes effect for
        // this tab, which is what the person clicking the menu asked for.
      }
      enabled = next;
      if (next) install();
    },
    noteTransport(rung) {
      // Unconditional when on, because a rung recorded late tags the wrong
      // samples — and free when off, like everything else here.
      if (!isRecording()) return;
      currentRung = rung;
    },
    noteTier(next) {
      if (!isRecording()) return;
      tier = next;
    },
    noteEngine(next) {
      if (!isRecording()) return;
      engine = next;
    },
    noteRtt(ms) {
      if (!isRecording()) return;
      push(rtt, ms);
    },
    noteFrameArrived({ bytes }) {
      if (!isRecording()) return;
      const at = now();
      arrivals.push({ at, bytes });
      trimRates(at);
    },
    notePainted(frame) {
      if (!isRecording()) return;
      const at = now();
      framesPainted += 1;
      if (frame.width) width = frame.width;
      if (frame.height) height = frame.height;
      if (frame.decodeMs !== undefined) push(decode, frame.decodeMs, frame.rung);
      const stamp = frame.relayTs ?? frame.ts;
      if (stamp !== undefined) push(captureToPaint, at - stamp, frame.rung);
      // Expired HERE as well as on send. `noteInputSent` is not a reliable
      // expiry point: a gesture followed by silence leaves its entry sitting
      // until the next input, and a frame arriving minutes later would settle
      // it as a multi-second "echo" — poisoning the one percentile this exists
      // to report.
      awaitingPaint = awaitingPaint.filter(
        (entry) => at - entry.sentAt < INPUT_TIMEOUT_MS,
      );
      const seq = frame.seq;
      if (seq === undefined) return;
      const settled = awaitingPaint.filter((entry) => seq > entry.afterSeq);
      if (settled.length === 0) return;
      awaitingPaint = awaitingPaint.filter((entry) => seq <= entry.afterSeq);
      for (const entry of settled) push(inputToPaint, at - entry.sentAt);
    },
    noteInputSent(afterSeq, seq) {
      if (!isRecording()) return;
      const at = now();
      awaitingPaint.push({ sentAt: at, afterSeq });
      awaitingPaint = awaitingPaint.filter(
        (entry) => at - entry.sentAt < INPUT_TIMEOUT_MS,
      );
      if (seq === undefined) return;
      awaitingAck.set(seq, at);
      if (awaitingAck.size > 256) {
        // A relay that stopped acking must not grow this without bound.
        awaitingAck = new Map(
          [...awaitingAck].filter(([, sentAt]) => at - sentAt < INPUT_TIMEOUT_MS),
        );
      }
    },
    noteInputAck(seq) {
      if (!isRecording()) return;
      const sentAt = awaitingAck.get(seq);
      if (sentAt === undefined) return;
      awaitingAck.delete(seq);
      push(inputToAck, now() - sentAt);
    },
    noteRelayStats(stats) {
      if (!isRecording()) return;
      relay = stats;
    },
    noteDaemonStats(daemon) {
      if (!isRecording()) return;
      relay = {
        framesIn: 0,
        bytes: 0,
        dropped: 0,
        subscribers: 0,
        ...relay,
        ...(daemon ? { daemon } : {}),
      };
    },
    report() {
      const byTransport: Partial<Record<FrameTransportRung, FrameStatsBucket>> =
        {};
      for (const sample of captureToPaint) {
        if (byTransport[sample.rung]) continue;
        byTransport[sample.rung] = bucket(
          captureToPaint.filter((entry) => entry.rung === sample.rung),
        );
      }
      return {
        captureToPaint: bucket(captureToPaint),
        inputToPaint: bucket(inputToPaint),
        inputToAck: bucket(inputToAck),
        rtt: bucket(rtt),
        decode: bucket(decode),
        byTransport,
      };
    },
    live() {
      const at = now();
      trimRates(at);
      const span = arrivals.length > 0 ? RATE_WINDOW_MS / 1_000 : 0;
      const bytes = arrivals.reduce((total, entry) => total + entry.bytes, 0);
      return {
        transport: currentRung,
        tier,
        engine,
        width,
        height,
        fps: span > 0 ? round1(arrivals.length / span) : 0,
        kbps: span > 0 ? Math.round((bytes * 8) / span / 1_000) : 0,
        ...(percentile(rtt, 50) !== undefined ? { rtt: percentile(rtt, 50)! } : {}),
        ...(percentile(captureToPaint, 50) !== undefined
          ? { captureToPaintP50: percentile(captureToPaint, 50)! }
          : {}),
        ...(percentile(inputToPaint, 50) !== undefined
          ? { inputToPaintP50: percentile(inputToPaint, 50)! }
          : {}),
        ...(percentile(inputToPaint, 95) !== undefined
          ? { inputToPaintP95: percentile(inputToPaint, 95)! }
          : {}),
        framesPainted,
        ...(relay ? { relay } : {}),
      };
    },
    reset() {
      captureToPaint.length = 0;
      inputToPaint.length = 0;
      inputToAck.length = 0;
      rtt.length = 0;
      decode.length = 0;
      awaitingPaint = [];
      awaitingAck = new Map();
      arrivals = [];
      framesPainted = 0;
      relay = undefined;
      // The RUNG is deliberately kept. This is also the console reset, which
      // somebody runs mid-session to start a clean measurement — and a rung
      // cleared here would tag every frame after it as `none` until the
      // transport happened to change.
    },
    resetFlagForTests() {
      enabled = undefined;
      installed = false;
      api.reset();
      currentRung = "none";
      tier = "auto";
      engine = "";
      width = 0;
      height = 0;
    },
  };

  return api;
}

function percentile(samples: Sample[], p: number): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = samples.map((sample) => sample.v).sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Math.round(sorted[index]!);
}

function bucket(samples: Sample[]): FrameStatsBucket {
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  return {
    n: samples.length,
    ...(p50 !== undefined ? { p50 } : {}),
    ...(p95 !== undefined ? { p95 } : {}),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The `localStorage` key that shows the browser pane's overlay. */
export const BROWSER_PANE_STATS_FLAG = "browser:frame-stats";

/**
 * The browser pane's instance.
 *
 * A module singleton because the pane is a singleton: one rail, one picture,
 * and an overlay that has to answer "what is this stream doing right now"
 * without every component threading a handle down to the canvas.
 */
export const paneFrameStats = createFrameStats({
  flag: BROWSER_PANE_STATS_FLAG,
  globalName: "browserPaneFrameStats",
  // The flag draws the overlay; it does not decide whether anything is
  // measured. See `alwaysRecord`.
  alwaysRecord: true,
});
