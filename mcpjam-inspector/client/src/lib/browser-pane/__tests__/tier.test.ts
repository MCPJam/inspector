/**
 * Adaptive quality.
 *
 * The failure this exists to prevent is specific and easy to write by accident:
 * `mpdecimate` means an idle page produces NO frames, so a page somebody is
 * READING looks exactly like a link that has fallen over. An implementation
 * that counted silence as loss would step a static page down to the saver tier
 * within seconds — precisely backwards, since reading is when sharpness
 * matters most.
 */
import { describe, expect, it } from "vitest";
import { createTierController, encoderTierFor } from "../tier";

/**
 * One stream's cumulative counters, fed a reading at a time.
 *
 * CUMULATIVE, because the relay's `stats` message is: the controller reads
 * deltas, and a helper that restarted its counters would hand it negative ones
 * — which read as "no frames flowed", the one case the controller ignores
 * outright.
 */
function stream(controller: ReturnType<typeof createTierController>) {
  let framesIn = 0;
  let dropped = 0;
  return {
    feed(
      count: number,
      reading: {
        frames: number;
        dropped: number;
        rtt?: number;
        idle?: boolean;
      },
    ) {
      let tier = controller.current();
      for (let i = 0; i < count; i += 1) {
        framesIn += reading.frames;
        dropped += reading.dropped;
        tier = controller.observe({
          framesIn,
          dropped,
          ...(reading.rtt !== undefined ? { rtt: reading.rtt } : {}),
          ...(reading.idle !== undefined ? { encoderIdle: reading.idle } : {}),
        });
      }
      return tier;
    },
  };
}

describe("auto", () => {
  it("steps down only after the evidence agrees with itself", () => {
    const controller = createTierController();
    const link = stream(controller);
    // Prime the deltas.
    link.feed(1, { frames: 0, dropped: 0 });
    // One bad second is a hiccup.
    expect(link.feed(2, { frames: 20, dropped: 10 })).toBe("auto");
    expect(link.feed(1, { frames: 20, dropped: 10 })).toBe("saver");
  });

  it("recovers as deliberately as it degrades", () => {
    const controller = createTierController();
    const link = stream(controller);
    link.feed(1, { frames: 0, dropped: 0 });
    link.feed(3, { frames: 20, dropped: 10 });
    expect(controller.current()).toBe("saver");
    expect(link.feed(4, { frames: 30, dropped: 0 })).toBe("saver");
    expect(link.feed(1, { frames: 30, dropped: 0 })).toBe("auto");
  });

  it("never steps down on a page that is simply not moving", () => {
    // The whole point. A person reading a static page for a minute must not
    // have it blurred underneath them.
    const controller = createTierController();
    controller.observe({ framesIn: 0, dropped: 0 });
    for (let i = 0; i < 60; i += 1) {
      // No frames at all, and the daemon saying why.
      expect(
        controller.observe({ framesIn: 0, dropped: 0, encoderIdle: true }),
      ).toBe("auto");
    }
  });

  it("ignores an idle heartbeat even when frames appear to have moved", () => {
    // `encoderIdle` is the daemon's own word about its encoder; it beats an
    // inference drawn from counters that can also move for other reasons.
    const controller = createTierController();
    controller.observe({ framesIn: 0, dropped: 0 });
    expect(
      stream(controller).feed(5, { frames: 1, dropped: 10, idle: true }),
    ).toBe("auto");
  });

  it("does not sacrifice sharpness because of round trip alone", () => {
    // A transatlantic hop is ~150ms and perfectly watchable; the thing that
    // actually ruins a pane is loss.
    const controller = createTierController();
    const link = stream(controller);
    link.feed(1, { frames: 0, dropped: 0 });
    expect(link.feed(3, { frames: 30, dropped: 0, rtt: 150 })).toBe("auto");
    expect(link.feed(3, { frames: 30, dropped: 0, rtt: 600 })).toBe("auto");
  });

  it("does not flip while the link hovers between the thresholds", () => {
    // The gap between degrade and recover: without it, a link sitting on one
    // number would change the tier every second.
    const controller = createTierController();
    const link = stream(controller);
    link.feed(1, { frames: 0, dropped: 0 });
    // 5% loss: above recover, below degrade.
    expect(link.feed(10, { frames: 95, dropped: 5 })).toBe("auto");
  });
});

describe("a tier somebody chose", () => {
  it("is not overridden by the controller", () => {
    const controller = createTierController();
    expect(controller.setPreference("sharp")).toBe("sharp");
    expect(stream(controller).feed(10, { frames: 10, dropped: 30 })).toBe(
      "sharp",
    );
  });

  it("hands the decision back cleanly", () => {
    const controller = createTierController();
    const link = stream(controller);
    link.feed(1, { frames: 0, dropped: 0 });
    link.feed(2, { frames: 20, dropped: 10 });
    // Picking a tier mid-argument resets it, so auto does not resume one
    // reading away from a step it started three seconds ago.
    controller.setPreference("sharp");
    controller.setPreference("auto");
    expect(link.feed(2, { frames: 20, dropped: 10 })).toBe("auto");
  });
});

describe("what the daemon is asked for", () => {
  it("maps a transport choice onto the encoder's own default", () => {
    // `mjpeg` and `vnc` are choices about which transport to use at all, not
    // instructions to an encoder that has no such preset.
    expect(encoderTierFor("sharp")).toBe("sharp");
    expect(encoderTierFor("saver")).toBe("saver");
    expect(encoderTierFor("mjpeg")).toBe("auto");
    expect(encoderTierFor("vnc")).toBe("auto");
    expect(encoderTierFor("auto")).toBe("auto");
  });
});
