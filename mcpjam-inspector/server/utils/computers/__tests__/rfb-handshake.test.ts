/**
 * The handshake the inspector performs on the viewer's behalf, so the viewer
 * never receives the desktop's password.
 *
 * The DES details here are the ones that fail silently when wrong: a handshake
 * built with an unreversed key, or with all 16 characters of E2B's auth key,
 * produces a perfectly well-formed response that the server simply rejects.
 */
import { describe, expect, it } from "vitest";
import {
  clientInit,
  parseProtocolVersion,
  parseSecurityResult,
  parseSecurityTypes,
  securityResultOk,
  securityTypesOffer,
  serverInitLength,
  vncAuthResponse,
  vncPasswordKey,
  RFB_SECURITY,
} from "../rfb-handshake";

describe("protocol version", () => {
  it("accepts the 3.8 greeting", () => {
    expect(parseProtocolVersion(Buffer.from("RFB 003.008\n"))).toBe(
      "RFB 003.008\n",
    );
  });

  it("waits for all 12 bytes", () => {
    expect(parseProtocolVersion(Buffer.from("RFB 003."))).toBeNull();
  });

  it("rejects something that is not a greeting", () => {
    expect(parseProtocolVersion(Buffer.from("HTTP/1.1 200"))).toBeNull();
  });
});

describe("security types", () => {
  it("reads the offered list", () => {
    expect(parseSecurityTypes(Buffer.from([2, 1, 2]))).toEqual([1, 2]);
  });

  it("reports a zero count as a failure list rather than a parse error", () => {
    // A 3.8 server that cannot proceed sends 0 followed by a reason string.
    expect(parseSecurityTypes(Buffer.from([0]))).toEqual([]);
  });

  it("waits for the whole list", () => {
    expect(parseSecurityTypes(Buffer.from([3, 1, 2]))).toBeNull();
  });

  it("offers the browser None, and only None", () => {
    // The socket is already authenticated by the panel's own short-lived
    // token, and the browser has no password because it must never be given
    // one.
    expect(securityTypesOffer()).toEqual(Buffer.from([1, RFB_SECURITY.NONE]));
  });
});

describe("VNC authentication", () => {
  it("bit-reverses each key byte", () => {
    // VNC's DES predates the bit order every modern implementation uses.
    // 0x01 -> 0x80, 0x02 -> 0x40, and so on.
    expect(Array.from(vncPasswordKey(String.fromCharCode(1, 2)))).toEqual([
      0x80, 0x40, 0, 0, 0, 0, 0, 0,
    ]);
    // A key fed in unreversed produces a well-formed response the server
    // simply rejects — no error anywhere, just a handshake that fails.
    expect(Array.from(vncPasswordKey(String.fromCharCode(0xff)))).toEqual([
      0xff, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("truncates to 8 bytes — E2B mints 16 and x11vnc keeps the first 8", () => {
    const sixteen = "abcdefghIGNORED!";
    expect(vncPasswordKey(sixteen)).toEqual(vncPasswordKey("abcdefgh"));
  });

  it("zero-pads a short password", () => {
    const key = vncPasswordKey("ab");
    expect(key.length).toBe(8);
    expect(Array.from(key.subarray(2))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("produces a 16-byte response for a 16-byte challenge", () => {
    const response = vncAuthResponse(Buffer.alloc(16, 0xab), "secret");
    expect(response.length).toBe(16);
  });

  it("encrypts the two blocks independently (ECB, not CBC)", () => {
    // ECB means identical plaintext blocks encrypt identically. If this ever
    // reads as CBC the second block differs, and the server rejects the auth.
    const response = vncAuthResponse(Buffer.alloc(16, 0x42), "secret");
    expect(response.subarray(0, 8)).toEqual(response.subarray(8, 16));
  });

  it("is deterministic, and depends on the password", () => {
    const challenge = Buffer.alloc(16, 7);
    expect(vncAuthResponse(challenge, "a")).toEqual(
      vncAuthResponse(challenge, "a"),
    );
    expect(vncAuthResponse(challenge, "a")).not.toEqual(
      vncAuthResponse(challenge, "b"),
    );
  });

  it("refuses a challenge that is not 16 bytes", () => {
    expect(() => vncAuthResponse(Buffer.alloc(8), "secret")).toThrow();
  });
});

describe("results and init", () => {
  it("reads a big-endian security result", () => {
    expect(parseSecurityResult(Buffer.from([0, 0, 0, 0]))).toBe(0);
    expect(parseSecurityResult(Buffer.from([0, 0, 0, 1]))).toBe(1);
    expect(parseSecurityResult(Buffer.from([0, 0]))).toBeNull();
  });

  it("tells the browser its authentication succeeded", () => {
    expect(securityResultOk()).toEqual(Buffer.from([0, 0, 0, 0]));
  });

  it("shares the desktop rather than evicting other viewers", () => {
    // The panel is a second viewer alongside whatever else is watching.
    expect(clientInit()).toEqual(Buffer.from([1]));
  });

  it("measures ServerInit including its variable-length name", () => {
    const init = Buffer.alloc(24);
    init.writeUInt32BE(5, 20);
    expect(serverInitLength(init)).toBe(29);
    expect(serverInitLength(Buffer.alloc(20))).toBeNull();
  });
});
