/**
 * The RFB 3.8 handshake, as the side that KNOWS the password.
 *
 * The Browser panel used to hand the noVNC password to the browser, in an
 * iframe URL. That password is not a view credential: the daemon's lease gates
 * model-driven commands, not VNC input, and `view_only` is a flag the client
 * sets on itself. Anyone who read it out of the DOM had full keyboard and
 * mouse on the member's desktop, for as long as the stream lived.
 *
 * So the inspector holds the password and speaks RFB itself: it authenticates
 * to the sandbox's VNC server server-side, then offers the browser security
 * type `None` on a socket that is already authenticated by the panel's own
 * short-lived token. The credential never leaves the replica.
 *
 * Pure byte-level helpers, unit-tested against the protocol. The live socket
 * work is in `routes/web/computer-browser-stream.ts`.
 *
 * Reference: RFC 6143 §7.1 (handshake) and §7.2.2 (VNC authentication).
 */
import { createCipheriv } from "node:crypto";

export const RFB_PROTOCOL_VERSION_3_8 = "RFB 003.008\n";

export const RFB_SECURITY = {
  INVALID: 0,
  NONE: 1,
  VNC_AUTH: 2,
} as const;

export const RFB_SECURITY_RESULT = {
  OK: 0,
  FAILED: 1,
} as const;

/** The server's greeting: exactly 12 ASCII bytes, `RFB 003.008\n`. */
export function parseProtocolVersion(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  const text = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
  return /^RFB \d{3}\.\d{3}\n$/.test(text) ? text : null;
}

/**
 * The security types a 3.8 server offers: a count byte, then that many type
 * bytes. A count of 0 means failure, and the reason follows as a string —
 * reported here as an empty list so the caller can read it.
 */
export function parseSecurityTypes(bytes: Uint8Array): number[] | null {
  if (bytes.length < 1) return null;
  const count = bytes[0]!;
  if (count === 0) return [];
  if (bytes.length < 1 + count) return null;
  return Array.from(bytes.subarray(1, 1 + count));
}

/**
 * Turn a VNC password into the 8-byte DES key the challenge is encrypted with.
 *
 * Two details that are easy to get wrong and silently produce a rejected
 * handshake rather than an error:
 *
 *   - The password is TRUNCATED to 8 bytes and zero-padded. E2B mints a
 *     16-character key, and `x11vnc -storepasswd` keeps the first 8 — so the
 *     bytes that matter are the first 8, and using all 16 fails.
 *   - Each byte is BIT-REVERSED. VNC's DES predates the convention every
 *     modern DES implementation uses, so a key fed in unreversed produces a
 *     valid-looking response that the server rejects.
 */
export function vncPasswordKey(password: string): Buffer {
  const key = Buffer.alloc(8, 0);
  const raw = Buffer.from(password, "latin1");
  raw.copy(key, 0, 0, Math.min(8, raw.length));
  for (let i = 0; i < 8; i += 1) {
    let byte = key[i]!;
    let reversed = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      reversed = (reversed << 1) | (byte & 1);
      byte >>= 1;
    }
    key[i] = reversed;
  }
  return key;
}

/**
 * The 16-byte response to a VNC-auth challenge: the challenge, DES-ECB
 * encrypted with the password key, in two 8-byte blocks.
 *
 * Node exposes no single-DES cipher — `crypto.getCiphers()` offers only the
 * `des-ede*` family — so this uses 3DES with all three key slots set to the
 * same 8 bytes. EDE with K1=K2=K3 is single DES by construction
 * (encrypt-decrypt-encrypt collapses to one encrypt), so the output is
 * byte-identical to what a `des-ecb` implementation would produce.
 */
export function vncAuthResponse(
  challenge: Uint8Array,
  password: string,
): Buffer {
  if (challenge.length !== 16) {
    throw new Error(`VNC challenge must be 16 bytes, got ${challenge.length}`);
  }
  const key = vncPasswordKey(password);
  const cipher = createCipheriv(
    "des-ede3",
    Buffer.concat([key, key, key]),
    null,
  );
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.from(challenge)), cipher.final()]);
}

/** `SecurityResult`: 4 bytes, big-endian. 0 is success. */
export function parseSecurityResult(bytes: Uint8Array): number | null {
  if (bytes.length < 4) return null;
  return Buffer.from(bytes.subarray(0, 4)).readUInt32BE(0);
}

/** ClientInit is one byte: shared-desktop flag. Always share — the panel is a
 *  second viewer alongside whatever else is watching, never an evictor. */
export function clientInit(shared = true): Buffer {
  return Buffer.from([shared ? 1 : 0]);
}

/**
 * What we offer the BROWSER once we have authenticated upstream ourselves:
 * one security type, `None`. The socket carrying this is already authenticated
 * by the panel's browser token, and the browser has no password to present
 * because it must never be given one.
 */
export function securityTypesOffer(): Buffer {
  return Buffer.from([1, RFB_SECURITY.NONE]);
}

export function securityResultOk(): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(RFB_SECURITY_RESULT.OK, 0);
  return buf;
}

/**
 * ServerInit's length, given its first bytes. Fixed 24-byte header (framebuffer
 * dimensions, pixel format, name length) plus a variable-length name. Needed so
 * the proxy knows where the handshake ends and the message stream begins.
 */
export function serverInitLength(bytes: Uint8Array): number | null {
  if (bytes.length < 24) return null;
  const nameLength = Buffer.from(bytes.subarray(20, 24)).readUInt32BE(0);
  return 24 + nameLength;
}
