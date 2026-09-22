/**
 * The input gate for the Browser panel's stream.
 *
 * This is the ONLY thing standing between a viewer and someone's desktop
 * keyboard: the daemon's handoff lease governs model-driven commands and knows
 * nothing about VNC, and `view_only` is a flag the client applies to itself.
 * So these tests are written from the attacker's side — a viewer who strips
 * `view_only`, or points a raw RFB client at the socket with a valid panel
 * token, and tries every message type that can reach an input queue.
 */
import { describe, expect, it } from "vitest";
import {
  measureClientMessage,
  RfbClientFilter,
  RFB_CLIENT_MESSAGE,
} from "../rfb-client-filter";

/** Every client→server message type, with a well-formed body. */
const MESSAGES: Array<{
  name: string;
  type: number;
  bytes: Buffer;
  /** Does it reach the desktop's input queue? */
  input: boolean;
  /** Allowed even WITH the lease? (power control and resize never are.) */
  everAllowed?: boolean;
}> = [
  {
    name: "SetPixelFormat",
    type: 0,
    bytes: Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.alloc(16)]),
    input: false,
  },
  {
    name: "SetEncodings",
    type: 2,
    bytes: Buffer.concat([
      Buffer.from([2, 0, 0, 2]),
      Buffer.alloc(8), // two encodings
    ]),
    input: false,
  },
  {
    name: "FramebufferUpdateRequest",
    type: 3,
    bytes: Buffer.concat([Buffer.from([3, 1]), Buffer.alloc(8)]),
    input: false,
  },
  {
    name: "KeyEvent",
    type: 4,
    bytes: Buffer.concat([Buffer.from([4, 1, 0, 0]), Buffer.alloc(4)]),
    input: true,
  },
  {
    name: "PointerEvent",
    type: 5,
    bytes: Buffer.concat([Buffer.from([5, 1]), Buffer.alloc(4)]),
    input: true,
  },
  {
    name: "ClientCutText",
    type: 6,
    bytes: Buffer.concat([
      Buffer.from([6, 0, 0, 0, 0, 0, 0, 3]),
      Buffer.from("abc"),
    ]),
    input: true,
  },
  {
    name: "EnableContinuousUpdates",
    type: 150,
    bytes: Buffer.concat([Buffer.from([150, 1]), Buffer.alloc(8)]),
    input: false,
  },
  {
    name: "Fence",
    type: 248,
    bytes: Buffer.concat([Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 0])]),
    input: false,
  },
  {
    name: "xvp (power control)",
    type: 250,
    bytes: Buffer.from([250, 0, 1, 2]),
    input: true,
    everAllowed: false,
  },
  {
    name: "SetDesktopSize",
    type: 251,
    // ONE screen, not zero. With a zero count both the real offset (6) and
    // the padding beside it (7) measure the same 8 bytes, so a fixture of
    // zeros cannot tell a correct parser from one reading a byte late.
    bytes: Buffer.concat([
      Buffer.from([251, 0, 0, 0, 0, 0, 1, 0]),
      Buffer.alloc(16),
    ]),
    input: true,
    everAllowed: false,
  },
  {
    name: "QEMUExtendedKeyEvent",
    type: 255,
    bytes: Buffer.concat([Buffer.from([255, 0]), Buffer.alloc(10)]),
    input: true,
  },
];

describe("measureClientMessage — framing", () => {
  it("measures every known client message exactly", () => {
    for (const message of MESSAGES) {
      const decision = measureClientMessage(message.bytes, true);
      expect(decision, message.name).toMatchObject({
        kind: "message",
        type: message.type,
        bytes: message.bytes.length,
      });
    }
  });

  it("asks for more bytes rather than guessing at a partial message", () => {
    for (const message of MESSAGES) {
      for (let cut = 1; cut < message.bytes.length; cut += 1) {
        expect(
          measureClientMessage(message.bytes.subarray(0, cut), true).kind,
          `${message.name} cut at ${cut}`,
        ).toBe("incomplete");
      }
    }
  });

  it("refuses an unknown type rather than trying to skip it", () => {
    // Its length is unknowable, so the stream cannot be resynchronised past
    // it — and a desynchronised stream is one whose input cannot be blocked.
    expect(
      measureClientMessage(Buffer.from([99, 0, 0, 0]), true),
    ).toMatchObject({ kind: "invalid" });
  });

  it("reads the extended clipboard's NEGATIVE length correctly", () => {
    // Read unsigned this is a ~4 GiB length: the parser either waits forever
    // for bytes that never arrive, or walks into the following message.
    const extended = Buffer.concat([
      Buffer.from([6, 0, 0, 0]),
      (() => {
        const b = Buffer.alloc(4);
        b.writeInt32BE(-4, 0);
        return b;
      })(),
      Buffer.alloc(4),
    ]);
    expect(measureClientMessage(extended, true)).toMatchObject({
      kind: "message",
      bytes: 12,
    });
  });

  it("refuses an absurd clipboard length instead of buffering it", () => {
    const huge = Buffer.concat([
      Buffer.from([6, 0, 0, 0]),
      (() => {
        const b = Buffer.alloc(4);
        b.writeInt32BE(0x7fffffff, 0);
        return b;
      })(),
    ]);
    expect(measureClientMessage(huge, true)).toMatchObject({ kind: "invalid" });
  });
});

describe("measureClientMessage — the gate", () => {
  it("drops every input-bearing message without the lease", () => {
    for (const message of MESSAGES.filter((m) => m.input)) {
      expect(
        measureClientMessage(message.bytes, false),
        message.name,
      ).toMatchObject({ allowed: false });
    }
  });

  it("passes input-bearing messages once the lease is held", () => {
    for (const message of MESSAGES.filter(
      (m) => m.input && m.everAllowed !== false,
    )) {
      expect(
        measureClientMessage(message.bytes, true),
        message.name,
      ).toMatchObject({ allowed: true });
    }
  });

  it("never passes power control or a desktop resize, lease or not", () => {
    for (const message of MESSAGES.filter((m) => m.everAllowed === false)) {
      for (const holds of [true, false]) {
        expect(
          measureClientMessage(message.bytes, holds),
          `${message.name} holds=${holds}`,
        ).toMatchObject({ allowed: false });
      }
    }
  });

  it("passes viewer-side messages with or without the lease", () => {
    for (const message of MESSAGES.filter((m) => !m.input)) {
      for (const holds of [true, false]) {
        expect(
          measureClientMessage(message.bytes, holds),
          `${message.name} holds=${holds}`,
        ).toMatchObject({ allowed: true });
      }
    }
  });

  it("blocks QEMUExtendedKeyEvent — the one a denylist misses", () => {
    // noVNC sends 255 instead of KeyEvent for every keystroke once the QEMU
    // pseudo-encoding is negotiated, which servers do by default. A filter
    // that drops only 4/5/6 lets a viewer type freely.
    const qemu = MESSAGES.find((m) => m.type === RFB_CLIENT_MESSAGE.QEMU)!;
    expect(measureClientMessage(qemu.bytes, false)).toMatchObject({
      allowed: false,
    });
  });
});

describe("RfbClientFilter — across frame boundaries", () => {
  it("reassembles messages split across websocket frames", () => {
    // websockify relays TCP, so a frame is not a message. A parser that
    // assumes otherwise desynchronises and reads bodies as types.
    const filter = new RfbClientFilter();
    filter.setHoldsInput(true);
    const stream = Buffer.concat(MESSAGES.map((m) => m.bytes));

    const forwarded: Buffer[] = [];
    for (let i = 0; i < stream.length; i += 3) {
      const result = filter.push(stream.subarray(i, i + 3));
      expect(result.ok).toBe(true);
      if (result.ok) forwarded.push(result.forward);
    }

    const expected = Buffer.concat(
      MESSAGES.filter((m) => m.everAllowed !== false).map((m) => m.bytes),
    );
    expect(Buffer.concat(forwarded)).toEqual(expected);
  });

  it("drops only the disallowed messages, leaving the rest intact", () => {
    const filter = new RfbClientFilter();
    filter.setHoldsInput(false);
    const key = MESSAGES.find((m) => m.type === 4)!;
    const update = MESSAGES.find((m) => m.type === 3)!;

    const result = filter.push(
      Buffer.concat([key.bytes, update.bytes, key.bytes]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.forward).toEqual(update.bytes);
    expect(filter.dropped).toBe(2);
  });

  it("starts dropping again the moment the lease is lost mid-stream", () => {
    const filter = new RfbClientFilter();
    const key = MESSAGES.find((m) => m.type === 4)!;

    filter.setHoldsInput(true);
    const held = filter.push(key.bytes);
    expect(held.ok && held.forward.length).toBe(key.bytes.length);

    filter.setHoldsInput(false);
    const lost = filter.push(key.bytes);
    expect(lost.ok && lost.forward.length).toBe(0);
  });

  it("reports a stream it cannot parse, so the caller can close it", () => {
    const filter = new RfbClientFilter();
    const result = filter.push(Buffer.from([99, 1, 2, 3]));
    expect(result.ok).toBe(false);
  });
});
