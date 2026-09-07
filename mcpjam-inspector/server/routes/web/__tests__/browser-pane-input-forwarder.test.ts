/**
 * Ordering behind an ordered socket.
 *
 * The socket is ordered; the hop behind it is not. What these pin is the
 * consequence: one dispatch at a time, whatever queues behind it coalesced
 * rather than replayed, and a refusal answered as an ack — because "somebody
 * else has the browser" is the ordinary state of affairs while the agent is
 * driving, and a close would make the pane reconnect against a browser that is
 * working exactly as designed.
 */
import { describe, expect, it } from "vitest";
import {
  createRelayInputForwarder,
  type InputRefusal,
} from "../browser-pane-input-forwarder";
import { BROWSER_INPUT_BATCH_LIMIT } from "../../../../shared/browser-pane-input";

function build(
  outcome: () => { ok: true } | { ok: false; refused: InputRefusal } = () => ({
    ok: true,
  }),
) {
  const dispatched: Array<{ tabId?: string; events: unknown[] }> = [];
  const acks: Array<{ seq: number; dispatched: number; refused?: string }> = [];
  let landed = 0;
  let release: (() => void) | null = null;
  const forwarder = createRelayInputForwarder({
    dispatch: async (args) => {
      dispatched.push({ ...args, events: [...args.events] });
      if (release) {
        await new Promise<void>((resolve) => {
          const previous = release;
          release = () => {
            previous?.();
            resolve();
          };
        });
      }
      return outcome();
    },
    ack: (payload) => acks.push(payload),
    onDispatched: () => {
      landed += 1;
    },
  });
  return {
    forwarder,
    dispatched,
    acks,
    landed: () => landed,
    hold: () => {
      release = () => {};
    },
    release: () => {
      const fn = release;
      release = null;
      fn?.();
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** `text` is the one event kind the coalescer never merges. */
const texts = (count: number) =>
  Array.from({ length: count }, (_, at) => ({
    type: "text" as const,
    text: String(at),
  }));

describe("relay input forwarder", () => {
  it("sends the first batch straight through", async () => {
    const f = build();
    f.forwarder.submit({ seq: 1, events: [{ type: "text", text: "a" }] });
    await tick();
    expect(f.dispatched).toHaveLength(1);
    expect(f.acks).toEqual([{ seq: 1, dispatched: 1 }]);
    expect(f.landed()).toBe(1);
  });

  it("holds the rest behind one in flight and collapses the moves", async () => {
    const f = build();
    f.hold();
    f.forwarder.submit({
      seq: 1,
      events: [{ type: "mouse_move", x: 1, y: 1 }],
    });
    await tick();
    f.forwarder.submit({
      seq: 2,
      events: [{ type: "mouse_move", x: 2, y: 2 }],
    });
    f.forwarder.submit({
      seq: 3,
      events: [
        { type: "mouse_move", x: 3, y: 3 },
        { type: "mouse_up", x: 3, y: 3, button: "left" },
      ],
    });
    expect(f.dispatched).toHaveLength(1);

    f.release();
    await tick();
    await tick();
    expect(f.dispatched).toHaveLength(2);
    // The position they stopped at, with the release still behind it.
    expect(f.dispatched[1]?.events).toEqual([
      { type: "mouse_move", x: 3, y: 3 },
      { type: "mouse_up", x: 3, y: 3, button: "left" },
    ]);
    expect(f.acks.map((a) => a.seq)).toEqual([1, 2, 3]);
  });

  it("never merges two tabs' gestures into one dispatch", async () => {
    // Half a gesture on the wrong page is worse than a late one.
    const f = build();
    f.hold();
    f.forwarder.submit({ seq: 1, events: [{ type: "text", text: "a" }] });
    await tick();
    f.forwarder.submit({
      seq: 2,
      tabId: "tab-b",
      events: [{ type: "text", text: "b" }],
    });
    f.forwarder.submit({
      seq: 3,
      tabId: "tab-c",
      events: [{ type: "text", text: "c" }],
    });
    f.release();
    await tick();
    await tick();
    await tick();
    expect(f.dispatched.map((d) => d.tabId)).toEqual([
      undefined,
      "tab-b",
      "tab-c",
    ]);
  });

  it("acks a refusal rather than throwing it away", async () => {
    const f = build(() => ({ ok: false, refused: "lease_held" }));
    f.forwarder.submit({ seq: 4, events: [{ type: "text", text: "a" }] });
    await tick();
    expect(f.acks).toEqual([{ seq: 4, dispatched: 0, refused: "lease_held" }]);
    // A refusal is not use of the machine.
    expect(f.landed()).toBe(0);
  });

  it("reports a thrown dispatch as an upstream error, and keeps going", async () => {
    let calls = 0;
    const forwarderAcks: Array<{ seq: number; refused?: string }> = [];
    const forwarder = createRelayInputForwarder({
      dispatch: async () => {
        calls += 1;
        if (calls === 1) throw new Error("socket reset");
        return { ok: true };
      },
      ack: (payload) => forwarderAcks.push(payload),
    });
    forwarder.submit({ seq: 1, events: [{ type: "text", text: "a" }] });
    await tick();
    forwarder.submit({ seq: 2, events: [{ type: "text", text: "b" }] });
    await tick();
    expect(forwarderAcks).toEqual([
      { seq: 1, dispatched: 0, refused: "upstream_error" },
      { seq: 2, dispatched: 1 },
    ]);
  });

  it("drops what is queued when cancelled", async () => {
    const f = build();
    f.hold();
    f.forwarder.submit({ seq: 1, events: [{ type: "text", text: "a" }] });
    await tick();
    f.forwarder.submit({ seq: 2, events: [{ type: "text", text: "b" }] });
    f.forwarder.cancel();
    f.release();
    await tick();
    await tick();
    // The one already out went; the queued one did not, and neither was acked
    // into a socket that is gone.
    expect(f.dispatched).toHaveLength(1);
    expect(f.acks).toEqual([]);
    f.forwarder.submit({ seq: 3, events: [{ type: "text", text: "c" }] });
    await tick();
    expect(f.dispatched).toHaveLength(1);
  });
});

describe("bursts the daemon would refuse whole", () => {
  it("chunks a long burst at the daemon's own cap", async () => {
    // `/v1/input` answers 413 to an oversized batch and dispatches NOTHING of
    // it — so one fast drag refused the entire gesture, RELEASES INCLUDED, and
    // left the page holding a button nobody was pressing.
    const sizes: number[] = [];
    const acks: unknown[] = [];
    const forwarder = createRelayInputForwarder({
      dispatch: async ({ events }) => {
        sizes.push(events.length);
        return { ok: true as const };
      },
      ack: (payload) => acks.push(payload),
    });
    // Key events do not coalesce, so the burst survives to the dispatch.
    forwarder.submit({
      seq: 1,
      events: Array.from({ length: 150 }, (_, n) => ({
        type: "key_down" as const,
        key: String(n % 10),
      })),
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(sizes.every((size) => size <= BROWSER_INPUT_BATCH_LIMIT)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(150);
    expect(acks).toEqual([{ seq: 1, dispatched: 150 }]);
  });

  it("answers every batch it drops, rather than leaving a pane waiting", async () => {
    // Coalescing bounds ONE tab's queue; input that alternates tabs starts a
    // new group every message, and a slow page then lets an authenticated pane
    // grow this relay's memory without limit.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acks: Array<{ seq: number; refused?: string }> = [];
    const forwarder = createRelayInputForwarder({
      dispatch: async () => {
        await held;
        return { ok: true as const };
      },
      ack: (payload) => acks.push(payload),
    });
    for (let n = 1; n <= 80; n += 1) {
      forwarder.submit({
        seq: n,
        tabId: `tab-${n}`,
        events: [{ type: "mouse_move", x: n, y: n }],
      });
    }
    expect(acks.length).toBeGreaterThan(0);
    expect(acks.every((a) => a.refused === "overloaded")).toBe(true);
    // The NEWEST survive: a pane whose queue ran away has old positions that
    // are already wrong, and the gesture being made now is the one worth
    // keeping.
    expect(acks.map((a) => a.seq)).toEqual(
      acks.map((a) => a.seq).sort((a, b) => a - b),
    );
    expect(Math.max(...acks.map((a) => a.seq))).toBeLessThan(80);
    release();
  });

  it("stops chunking the moment the socket goes away", async () => {
    const f = build();
    f.hold();
    f.forwarder.submit({
      seq: 1,
      events: texts(BROWSER_INPUT_BATCH_LIMIT + 1),
    });
    await tick();
    expect(f.dispatched).toHaveLength(1);
    // The pane is gone. What is left of this gesture belongs to nobody, and
    // the lease may be somebody else's by the time it lands.
    f.forwarder.cancel();
    f.release();
    await tick();
    expect(f.dispatched).toHaveLength(1);
  });

  it("credits the part of a gesture that landed, and counts it as use", async () => {
    let calls = 0;
    const f = build(() => {
      calls += 1;
      return calls === 1
        ? { ok: true }
        : { ok: false, refused: "lease_held" as InputRefusal };
    });
    f.forwarder.submit({
      seq: 1,
      events: texts(BROWSER_INPUT_BATCH_LIMIT + 1),
    });
    await tick();
    expect(f.dispatched).toHaveLength(2);
    expect(f.acks).toEqual([
      { seq: 1, dispatched: BROWSER_INPUT_BATCH_LIMIT, refused: "lease_held" },
    ]);
    // A prefix that reached the page is somebody working, not somebody idle —
    // which is what defers the sweep on a metered machine.
    expect(f.landed()).toBe(1);
  });

  it("carries a release past the queue bound", async () => {
    const f = build();
    f.hold();
    // The press goes out at once...
    f.forwarder.submit({
      seq: 1,
      tabId: "a",
      events: [{ type: "mouse_down", x: 1, y: 1, button: "left" }],
    });
    await tick();
    // ...its release queues behind, and then alternating tabs bury it until
    // the bound evicts the group it is in.
    f.forwarder.submit({
      seq: 2,
      tabId: "b",
      events: [{ type: "mouse_up", x: 1, y: 1, button: "left" }],
    });
    for (let seq = 3; seq <= 40; seq += 1) {
      f.forwarder.submit({
        seq,
        tabId: seq % 2 === 0 ? "b" : "a",
        events: [{ type: "mouse_move", x: seq, y: seq }],
      });
    }
    f.release();
    for (let at = 0; at < 80; at += 1) await tick();
    // Its batch was refused — that much is the bound doing its job...
    expect(
      f.acks.some((ack) => ack.seq === 2 && ack.refused === "overloaded"),
    ).toBe(true);
    // ...but the release itself still reached the page it belonged to. A
    // dropped `mouse_up` leaves that page holding a button with no later
    // event able to end it.
    const releases = f.dispatched.filter((entry) =>
      entry.events.some(
        (event) => (event as { type?: string }).type === "mouse_up",
      ),
    );
    expect(releases).toHaveLength(1);
    expect(releases[0]!.tabId).toBe("b");
  });
});
