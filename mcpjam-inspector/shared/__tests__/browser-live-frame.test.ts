/**
 * isLiveBrowserFrame — the live-frame WIRE boundary.
 *
 * Frames cross a version gap in both directions (a newer runner streaming to an
 * older client, a client replaying a buffer a newer runner wrote), and the
 * reducer interpolates `thumbnailMediaType` straight into a `data:` URI. So this
 * guard is the only thing standing between another process's output and what gets
 * rendered — pin the contract before the two sides can diverge.
 */
import { describe, expect, it } from "vitest";
import {
  isLiveBrowserFrame,
  liveFrameStepKey,
  LIVE_FRAME_MAX_BYTES,
  type LiveBrowserFrame,
} from "../browser-live-frame";

function frame(overrides: Record<string, unknown> = {}): unknown {
  return {
    sequence: 1,
    promptIndex: 0,
    toolCallId: "tc-1",
    stepIndex: 0,
    action: "left_click",
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

describe("isLiveBrowserFrame", () => {
  it("accepts a minimal frame", () => {
    expect(isLiveBrowserFrame(frame())).toBe(true);
  });

  it("accepts a full frame with a thumbnail and coordinates", () => {
    expect(
      isLiveBrowserFrame(
        frame({
          coordinateX: 12,
          coordinateY: 34,
          thumbnailBase64: "aGVsbG8=",
          thumbnailMediaType: "image/png",
        }),
      ),
    ).toBe(true);
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, 7, "frame", [], true]) {
      expect(isLiveBrowserFrame(value)).toBe(false);
    }
  });

  it("rejects a missing required field", () => {
    for (const key of [
      "sequence",
      "promptIndex",
      "toolCallId",
      "stepIndex",
      "action",
      "ts",
    ]) {
      const partial = frame() as Record<string, unknown>;
      delete partial[key];
      expect(isLiveBrowserFrame(partial)).toBe(false);
    }
  });

  it("rejects non-finite numbers", () => {
    // A NaN stepIndex poisons the step key the filmstrip dedupes on; an
    // Infinity ts breaks its ordering. `typeof === "number"` isn't enough.
    for (const key of ["sequence", "promptIndex", "stepIndex", "ts"]) {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(isLiveBrowserFrame(frame({ [key]: bad }))).toBe(false);
      }
    }
  });

  it("rejects a non-finite coordinate but allows an absent one", () => {
    expect(isLiveBrowserFrame(frame({ coordinateX: Number.NaN }))).toBe(false);
    expect(isLiveBrowserFrame(frame({ coordinateY: "12" }))).toBe(false);
    expect(isLiveBrowserFrame(frame({ coordinateX: undefined }))).toBe(true);
  });

  it("rejects a media type outside the declared union", () => {
    // This value lands in a `data:` URI downstream, so it must be one of the two
    // literals we produce — never arbitrary caller-supplied text.
    expect(
      isLiveBrowserFrame(
        frame({ thumbnailBase64: "aGk=", thumbnailMediaType: "text/html" }),
      ),
    ).toBe(false);
    expect(
      isLiveBrowserFrame(
        frame({
          thumbnailBase64: "aGk=",
          thumbnailMediaType: "image/svg+xml,<script>",
        }),
      ),
    ).toBe(false);
    // Absent is fine — the reducer defaults it.
    expect(isLiveBrowserFrame(frame({ thumbnailBase64: "aGk=" }))).toBe(true);
  });

  it("rejects a thumbnail over the byte cap", () => {
    // The cap is enforced at READ too, not just at emit: a frame comes from
    // another process, and trusting its size would defeat the bound entirely.
    const overBase64Length = Math.ceil(((LIVE_FRAME_MAX_BYTES + 1) * 4) / 3) + 8;
    expect(
      isLiveBrowserFrame(
        frame({ thumbnailBase64: "A".repeat(overBase64Length) }),
      ),
    ).toBe(false);
    // Just under the cap still passes.
    const underBase64Length = Math.floor((LIVE_FRAME_MAX_BYTES * 4) / 3) - 8;
    expect(
      isLiveBrowserFrame(
        frame({ thumbnailBase64: "A".repeat(underBase64Length) }),
      ),
    ).toBe(true);
  });

  it("rejects a thumbnail that is not base64", () => {
    // Defence in depth: React escapes the attribute and the media type beside it
    // is allowlisted, so this can't inject — but a malformed payload should fail
    // at the boundary rather than become a `data:` URI that can only 404.
    for (const bad of [
      '"><img src=x onerror=alert(1)>',
      "not base64!",
      "AAAA AAAA",
      "AA=AAA",
    ]) {
      expect(isLiveBrowserFrame(frame({ thumbnailBase64: bad }))).toBe(false);
    }
  });

  it("accepts correctly padded base64", () => {
    for (const good of ["AAAA", "AAA=", "AA==", "AAAAAAA=", ""]) {
      expect(isLiveBrowserFrame(frame({ thumbnailBase64: good }))).toBe(true);
    }
  });

  it("rejects a non-string thumbnail", () => {
    expect(isLiveBrowserFrame(frame({ thumbnailBase64: 42 }))).toBe(false);
  });
});

describe("liveFrameStepKey", () => {
  it("matches the persisted step identity", () => {
    expect(
      liveFrameStepKey(
        frame({ toolCallId: "tc-9", stepIndex: 4 }) as LiveBrowserFrame,
      ),
    ).toBe("tc-9:4");
  });
});
