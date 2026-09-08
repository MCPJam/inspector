/**
 * Picking a quality tier from what the stream is actually doing.
 *
 * "Auto" is the only tier most people will ever choose, so it has to be right
 * without being twitchy — and the two ways to get it wrong are opposite. Step
 * down too eagerly and a page goes blurry because somebody's laptop slept for a
 * second; step down too late and the pane is already unusable by the time the
 * decision arrives.
 *
 * THE HARD PART IS TELLING A QUIET PAGE FROM A BROKEN ONE. `mpdecimate` means
 * an idle page produces NO frames at all, so silence is the NORMAL state of a
 * page nobody is touching — and every loss signal a naive implementation would
 * use (frames not arriving, an unchanged sequence) says exactly the same thing.
 * The daemon says which by setting `encoderIdle` on its heartbeat, and the rule
 * here is one line: loss ratios count only while frames are flowing.
 */

export type QualityTier = "auto" | "sharp" | "saver" | "mjpeg" | "vnc";

/** What the tier decision is made from. */
export interface TierSignals {
  /** Round trip to the relay, in ms. Undefined before the first pong. */
  rtt?: number;
  /** Frames the relay received, cumulative. */
  framesIn?: number;
  /** Frames the relay could not pass on, cumulative. */
  dropped?: number;
  /** The encoder has nothing to send: a quiet page, not a stall. */
  encoderIdle?: boolean;
}

/**
 * Above this round trip, sharp is not worth its bitrate.
 *
 * Generous: a transatlantic hop is ~150ms and perfectly watchable, and the
 * thing that actually makes a pane unusable is loss rather than latency.
 */
const RTT_DEGRADE_MS = 400;
const RTT_RECOVER_MS = 250;

/** Loss above this, while frames are flowing, is a link that cannot keep up. */
const LOSS_DEGRADE = 0.1;
const LOSS_RECOVER = 0.02;

/**
 * How many consecutive readings must agree before the tier moves.
 *
 * The hysteresis. One bad second is a hiccup; three in a row is a link. Applied
 * in BOTH directions, so recovering is as deliberate as degrading — a tier that
 * oscillated would be worse than either end of it.
 */
const CONSECUTIVE = 3;

export interface TierController {
  /**
   * Fold in one reading. Returns the tier to run at, which is unchanged unless
   * the evidence has agreed with itself `CONSECUTIVE` times.
   */
  observe(signals: TierSignals): QualityTier;
  /** What the person chose. `"auto"` is the only one this controller moves. */
  setPreference(tier: QualityTier): QualityTier;
  preference(): QualityTier;
  /** The tier in force right now. */
  current(): QualityTier;
}

export function createTierController(
  initial: QualityTier = "auto",
): TierController {
  let preference: QualityTier = initial;
  /** What auto has settled on. Only meaningful while the preference is auto. */
  let auto: QualityTier = "auto";
  let degradeRun = 0;
  let recoverRun = 0;
  let lastFramesIn: number | undefined;
  let lastDropped: number | undefined;

  const resolve = (): QualityTier =>
    preference === "auto" ? auto : preference;

  return {
    preference: () => preference,
    current: resolve,
    setPreference(tier) {
      preference = tier;
      if (tier !== "auto") {
        // A person who picked a tier has taken the decision away from us;
        // starting the runs over means auto does not resume mid-argument if
        // they hand it back.
        degradeRun = 0;
        recoverRun = 0;
      }
      return resolve();
    },
    observe(signals) {
      if (preference !== "auto") return resolve();

      const framesIn = signals.framesIn;
      const dropped = signals.dropped;
      const deltaFrames =
        framesIn !== undefined && lastFramesIn !== undefined
          ? framesIn - lastFramesIn
          : 0;
      const deltaDropped =
        dropped !== undefined && lastDropped !== undefined
          ? dropped - lastDropped
          : 0;
      if (framesIn !== undefined) lastFramesIn = framesIn;
      if (dropped !== undefined) lastDropped = dropped;

      // THE IDLE RULE. No frames flowed, or the daemon says its encoder has
      // nothing to send: there is no evidence either way, so nothing moves.
      // Without this a static page — somebody READING — would step itself down
      // to the saver tier within seconds, which is precisely backwards.
      const flowing = deltaFrames > 0 && signals.encoderIdle !== true;
      if (!flowing) {
        degradeRun = 0;
        recoverRun = 0;
        return resolve();
      }

      // `framesIn` is incremented for EVERY frame the relay was offered,
      // including the ones it went on to drop — so the dropped frames are
      // already in the denominator, and adding them again understated loss on
      // exactly the congested links this exists to notice.
      const loss = deltaDropped / deltaFrames;
      const rtt = signals.rtt;
      const bad =
        loss >= LOSS_DEGRADE || (rtt !== undefined && rtt >= RTT_DEGRADE_MS);
      const good =
        loss <= LOSS_RECOVER && (rtt === undefined || rtt <= RTT_RECOVER_MS);

      if (bad) {
        recoverRun = 0;
        degradeRun += 1;
      } else if (good) {
        degradeRun = 0;
        recoverRun += 1;
      } else {
        // Between the two thresholds: the gap that stops a link hovering on a
        // boundary from flipping the tier every second.
        degradeRun = 0;
        recoverRun = 0;
      }

      if (degradeRun >= CONSECUTIVE && auto !== "saver") {
        auto = "saver";
        degradeRun = 0;
      } else if (recoverRun >= CONSECUTIVE && auto !== "auto") {
        auto = "auto";
        recoverRun = 0;
      }
      return resolve();
    },
  };
}

/**
 * Which tier the DAEMON is asked to encode at.
 *
 * `mjpeg` and `vnc` are client-side choices about which transport to use at
 * all, not instructions to the encoder — so they map to the encoder's own
 * default rather than inventing a preset the daemon does not have.
 */
export function encoderTierFor(tier: QualityTier): "auto" | "sharp" | "saver" {
  return tier === "sharp" || tier === "saver" ? tier : "auto";
}
