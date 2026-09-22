import { describe, expect, it } from "vitest";
import {
  hashOauthState,
  oauthStateMatches,
  randomToken,
  signSlackLinkState,
  SLACK_LINK_STATE_TTL_MS,
  verifySlackLinkState,
} from "../state.js";

const SECRET = "test-secret";

describe("signed link state", () => {
  it("round-trips a valid payload", () => {
    const token = signSlackLinkState(
      { linkSessionId: "ls_1", exp: Date.now() + SLACK_LINK_STATE_TTL_MS },
      SECRET
    );
    expect(verifySlackLinkState(token, SECRET)?.linkSessionId).toBe("ls_1");
  });

  it("REJECTS a tampered payload", () => {
    // The signature is the only thing preventing someone from swapping in
    // another user's session id and completing THEIR link.
    const token = signSlackLinkState(
      { linkSessionId: "ls_1", exp: Date.now() + 60_000 },
      SECRET
    );
    const [body, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ linkSessionId: "ls_victim", exp: Date.now() + 60_000 }),
      "utf8"
    ).toString("base64url");
    expect(verifySlackLinkState(`${forged}.${signature}`, SECRET)).toBeNull();
    expect(body).not.toBe(forged);
  });

  it("REJECTS a signature from a different secret", () => {
    const token = signSlackLinkState(
      { linkSessionId: "ls_1", exp: Date.now() + 60_000 },
      "other-secret"
    );
    expect(verifySlackLinkState(token, SECRET)).toBeNull();
  });

  it("REJECTS an expired state", () => {
    // The URL lives in a Slack conversation forever; the window in which it
    // is worth anything must not.
    const token = signSlackLinkState(
      { linkSessionId: "ls_1", exp: Date.now() - 1 },
      SECRET
    );
    expect(verifySlackLinkState(token, SECRET)).toBeNull();
  });

  it("rejects malformed tokens instead of throwing", () => {
    for (const bad of ["", "no-dot", "a.b.c.", "....", "%%%.%%%"]) {
      expect(verifySlackLinkState(bad, SECRET)).toBeNull();
    }
  });
});

describe("per-leg OAuth states", () => {
  it("matches a state against its stored hash", () => {
    const state = randomToken();
    expect(oauthStateMatches(state, hashOauthState(state))).toBe(true);
  });

  it("rejects a different state", () => {
    expect(oauthStateMatches(randomToken(), hashOauthState(randomToken()))).toBe(
      false
    );
  });

  it("rejects a garbage hash without throwing", () => {
    expect(oauthStateMatches(randomToken(), "not-a-hash")).toBe(false);
  });

  it("generates distinct, high-entropy tokens", () => {
    // The two legs must never share a state: one shared value would let a
    // state observed on the Slack leg be replayed into the WorkOS leg.
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it("stores only the hash, never the state", () => {
    const state = randomToken();
    const hash = hashOauthState(state);
    expect(hash).not.toContain(state);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
