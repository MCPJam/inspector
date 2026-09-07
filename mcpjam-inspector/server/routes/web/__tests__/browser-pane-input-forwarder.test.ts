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
    f.forwarder.submit({ seq: 1, events: [{ type: "mouse_move", x: 1, y: 1 }] });
    await tick();
    f.forwarder.submit({ seq: 2, events: [{ type: "mouse_move", x: 2, y: 2 }] });
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
    expect(f.acks).toEqual([
      { seq: 4, dispatched: 0, refused: "lease_held" },
    ]);
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
