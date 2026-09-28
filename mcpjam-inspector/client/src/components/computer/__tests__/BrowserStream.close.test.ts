/**
 * The close-code policy for the browser video stream.
 *
 * Extracted as a pure function precisely so it can be tested without noVNC, a
 * WebSocket, or a DOM — the policy is the part that was wrong, and it is the
 * part a member notices: every deploy to an environment drains its replicas,
 * which closes this socket, which used to end the view for good.
 */
import { describe, expect, it } from "vitest";
import { reconnectDelayMs, streamCloseOutcome } from "../BrowserStream";

describe("streamCloseOutcome", () => {
  it("retries a drained replica (1001) — a deploy is not a dead browser", () => {
    expect(streamCloseOutcome({ code: 1001 })).toEqual({
      retry: true,
      detail: "The connection to the browser dropped.",
    });
  });

  it("retries a socket that died with no close frame (1006)", () => {
    expect(streamCloseOutcome({ code: 1006 }).retry).toBe(true);
  });

  it("still retries an expired token (4401)", () => {
    expect(streamCloseOutcome({ code: 4401 }).retry).toBe(true);
  });

  it("does not retry a browser that is gone (4404)", () => {
    expect(streamCloseOutcome({ code: 4404 })).toEqual({
      retry: false,
      detail: "The browser on this computer is no longer running.",
    });
  });

  it("shows the server's own reason rather than a generic line", () => {
    // 4503 with a sentence is what the stream proxy sends when the upstream
    // noVNC cannot be reached; that sentence is the whole diagnosis.
    expect(
      streamCloseOutcome({
        code: 4503,
        reason: "The browser stream did not respond.",
      }),
    ).toEqual({
      retry: false,
      detail: "The browser stream did not respond.",
    });
  });

  it("falls back to the generic line when the server sent no reason", () => {
    expect(streamCloseOutcome({ code: 4503, reason: "   " }).detail).toBe(
      "The connection to the browser dropped.",
    );
  });
});

describe("reconnectDelayMs", () => {
  it("backs off, because a restarting replica needs longer than 2.5s", () => {
    expect([1, 2, 3, 4, 5].map(reconnectDelayMs)).toEqual([
      500, 1000, 2000, 4000, 8000,
    ]);
  });
});
