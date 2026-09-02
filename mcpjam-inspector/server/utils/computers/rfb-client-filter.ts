/**
 * Which RFB messages a WATCHING browser is allowed to send.
 *
 * This is the real input gate for the Browser panel, and it is the only one.
 * The daemon's handoff lease stops MODEL-driven commands; it knows nothing
 * about VNC, so it cannot stop a pointer event arriving over the stream. And
 * `view_only` is a flag the noVNC client applies to itself — a viewer who
 * strips it, or who connects their own RFB client to this socket with a valid
 * panel token, is typing on somebody's desktop. So the filter runs here, on
 * the server, where a client cannot opt out of it.
 *
 * An ALLOWLIST, deliberately. The obvious version of this drops the three
 * input messages everyone knows (`KeyEvent`, `PointerEvent`, `ClientCutText`)
 * and passes the rest — and it is wrong, because noVNC sends
 * `QEMUExtendedKeyEvent` (255) for every keystroke as soon as the server
 * negotiates the QEMU pseudo-encoding, which is a complete bypass of a
 * three-message denylist. Anything not positively known to be harmless is
 * refused, so the next extension to add an input path is refused by default
 * rather than by whoever remembers to update a list.
 *
 * Pure, and framing-aware: websockify relays TCP, so a WebSocket frame is not
 * a message. One frame can carry three messages and half of a fourth, and a
 * parser that assumes otherwise desynchronises and starts reading message
 * bodies as message types.
 *
 * Reference: RFC 6143 §7.5, plus the QEMU and Fence/ContinuousUpdates
 * extensions noVNC negotiates.
 */

export const RFB_CLIENT_MESSAGE = {
  SET_PIXEL_FORMAT: 0,
  SET_ENCODINGS: 2,
  FRAMEBUFFER_UPDATE_REQUEST: 3,
  KEY_EVENT: 4,
  POINTER_EVENT: 5,
  CLIENT_CUT_TEXT: 6,
  QEMU: 255,
  SET_DESKTOP_SIZE: 251,
  XVP: 250,
  ENABLE_CONTINUOUS_UPDATES: 150,
  FENCE: 248,
} as const;

export type MessageDecision =
  /** A complete message; `bytes` long, forward or drop per `allowed`. */
  | { kind: "message"; type: number; bytes: number; allowed: boolean }
  /** Not enough bytes yet — wait for more, do not consume. */
  | { kind: "incomplete" }
  /** Unparseable: the stream has desynchronised or is not RFB. Close. */
  | { kind: "invalid"; reason: string };

/**
 * How long the message at the front of `buffer` is, or why we cannot say.
 *
 * `holdsInput` decides whether an input-bearing message is allowed through —
 * true only while the viewer holds the daemon's handoff lease.
 */
export function measureClientMessage(
  buffer: Uint8Array,
  holdsInput: boolean,
): MessageDecision {
  if (buffer.length < 1) return { kind: "incomplete" };
  const type = buffer[0]!;

  const decide = (bytes: number, allowed: boolean): MessageDecision =>
    buffer.length < bytes
      ? { kind: "incomplete" }
      : { kind: "message", type, bytes, allowed };

  switch (type) {
    case RFB_CLIENT_MESSAGE.SET_PIXEL_FORMAT:
      return decide(20, true);

    case RFB_CLIENT_MESSAGE.SET_ENCODINGS: {
      if (buffer.length < 4) return { kind: "incomplete" };
      const count = readU16(buffer, 2);
      return decide(4 + count * 4, true);
    }

    case RFB_CLIENT_MESSAGE.FRAMEBUFFER_UPDATE_REQUEST:
      return decide(10, true);

    case RFB_CLIENT_MESSAGE.KEY_EVENT:
      return decide(8, holdsInput);

    case RFB_CLIENT_MESSAGE.POINTER_EVENT:
      return decide(6, holdsInput);

    case RFB_CLIENT_MESSAGE.CLIENT_CUT_TEXT: {
      if (buffer.length < 8) return { kind: "incomplete" };
      // Signed on purpose. The extended clipboard uses a NEGATIVE length whose
      // magnitude is the payload size; reading it unsigned yields a length near
      // 4 GiB, and a parser that trusts it either stalls forever waiting for
      // bytes that never come or walks off into the next message.
      const length = readI32(buffer, 4);
      const payload = length < 0 ? -length : length;
      if (payload > MAX_CUT_TEXT_BYTES) {
        return { kind: "invalid", reason: `cut text too large (${payload})` };
      }
      // Pasting INTO the desktop is input, whichever form it takes.
      return decide(8 + payload, holdsInput);
    }

    case RFB_CLIENT_MESSAGE.ENABLE_CONTINUOUS_UPDATES:
      // Asks the server to push updates unprompted. About receiving, not
      // sending.
      return decide(10, true);

    case RFB_CLIENT_MESSAGE.FENCE: {
      if (buffer.length < 9) return { kind: "incomplete" };
      // type(1) + padding(3) + flags(4) + length(1) + payload
      return decide(9 + buffer[8]!, true);
    }

    case RFB_CLIENT_MESSAGE.QEMU: {
      // The one that makes a denylist useless. noVNC sends this instead of
      // KeyEvent for every keystroke once the QEMU pseudo-encoding is
      // negotiated, which the server does by default.
      if (buffer.length < 2) return { kind: "incomplete" };
      const subType = buffer[1]!;
      if (subType !== 0) {
        return { kind: "invalid", reason: `unknown QEMU sub-type ${subType}` };
      }
      return decide(12, holdsInput);
    }

    case RFB_CLIENT_MESSAGE.SET_DESKTOP_SIZE: {
      if (buffer.length < 8) return { kind: "incomplete" };
      const screens = buffer[7]!;
      // Never allowed, lease or not. Resizing a desktop someone else is also
      // looking at is not part of taking control of it, and the panel has no
      // reason to ask.
      return decide(8 + screens * 16, false);
    }

    case RFB_CLIENT_MESSAGE.XVP:
      // Power control: shutdown, reboot, reset. Never, under any lease.
      return decide(4, false);

    default:
      // Unknown type: its length is unknowable, so the stream cannot be
      // resynchronised past it. Refusing to guess is the only safe answer.
      return { kind: "invalid", reason: `unknown client message type ${type}` };
  }
}

/** Generous next to any real paste, small enough not to be a memory lever. */
const MAX_CUT_TEXT_BYTES = 1 << 20;

function readU16(buffer: Uint8Array, offset: number): number {
  return (buffer[offset]! << 8) | buffer[offset + 1]!;
}

function readI32(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset]! << 24) |
    (buffer[offset + 1]! << 16) |
    (buffer[offset + 2]! << 8) |
    buffer[offset + 3]! |
    0
  );
}

/**
 * A stateful filter over the client→server byte stream.
 *
 * Buffers across WebSocket frames, because websockify relays TCP chunks rather
 * than messages: `push` returns only the bytes that are complete AND allowed,
 * ready to forward upstream, and keeps any partial message for the next call.
 */
export class RfbClientFilter {
  private pending = Buffer.alloc(0);
  private holdsInput = false;
  /** Counts what was refused, for the panel to report and for tests. */
  private droppedCount = 0;

  /** Called whenever the lease changes hands. Losing it drops input again. */
  setHoldsInput(holds: boolean): void {
    this.holdsInput = holds;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * Feed one WebSocket frame. Returns the bytes to forward upstream, or an
   * error that must close the connection — a stream this cannot parse is one
   * whose input it also cannot reliably block.
   */
  push(
    chunk: Uint8Array,
  ): { ok: true; forward: Buffer } | { ok: false; reason: string } {
    this.pending =
      this.pending.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.pending, Buffer.from(chunk)]);

    const forward: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const view = this.pending.subarray(offset);
      const decision = measureClientMessage(view, this.holdsInput);
      if (decision.kind === "incomplete") break;
      if (decision.kind === "invalid") {
        return { ok: false, reason: decision.reason };
      }
      if (decision.allowed) {
        forward.push(Buffer.from(view.subarray(0, decision.bytes)));
      } else {
        this.droppedCount += 1;
      }
      offset += decision.bytes;
    }
    this.pending = this.pending.subarray(offset);
    return { ok: true, forward: Buffer.concat(forward) };
  }
}
