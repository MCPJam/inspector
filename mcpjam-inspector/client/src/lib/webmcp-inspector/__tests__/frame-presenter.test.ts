/**
 * The presenter's whole job is not leaking object URLs while never revoking
 * one an `<img>` might still be decoding. Both halves are timing rules, and
 * both are invisible until they break — a leak grows silently across a long
 * session, and an eager revoke shows up as an occasional broken image nobody
 * can reproduce. So they are pinned here rather than reasoned about.
 */
import { describe, it, expect, vi } from "vitest";
import { createFramePresenter } from "../frame-presenter";

function harness() {
  const created: string[] = [];
  const revoked: string[] = [];
  const deferred: Array<() => void> = [];
  let n = 0;
  const presenter = createFramePresenter({
    createUrl: () => {
      const url = `blob:${++n}`;
      created.push(url);
      return url;
    },
    revokeUrl: (url) => revoked.push(url),
    defer: (fn) => deferred.push(fn),
  });
  return {
    presenter,
    created,
    revoked,
    runDeferred: () => {
      const pending = deferred.splice(0, deferred.length);
      for (const fn of pending) fn();
    },
    deferredCount: () => deferred.length,
  };
}

const jpeg = (byte: number) => new Uint8Array([0xff, 0xd8, byte]);

describe("frame presenter", () => {
  it("revokes exactly URL N−2 as URL N is created", () => {
    const { presenter, created, revoked } = harness();

    presenter.present(jpeg(1));
    presenter.present(jpeg(2));
    // Nothing yet: URL 1 may still be the one on screen while 2 decodes.
    expect(revoked).toEqual([]);

    presenter.present(jpeg(3));
    expect(revoked).toEqual([created[0]]);

    presenter.present(jpeg(4));
    presenter.present(jpeg(5));
    expect(revoked).toEqual([created[0], created[1], created[2]]);
    // The two newest are always still owned.
    expect(revoked).not.toContain(created[3]);
    expect(revoked).not.toContain(created[4]);
  });

  it("clear() revokes on a LATER task, not synchronously", () => {
    const { presenter, created, revoked, runDeferred } = harness();
    presenter.present(jpeg(1));
    presenter.present(jpeg(2));

    presenter.clear();
    // A synchronous revoke here would yank the bytes out from under an element
    // that has not yet re-rendered without them.
    expect(revoked).toEqual([]);

    runDeferred();
    expect(new Set(revoked)).toEqual(new Set([created[0], created[1]]));
  });

  it("leaves nothing outstanding after clear", () => {
    const { presenter, created, revoked, runDeferred } = harness();
    for (let i = 0; i < 5; i += 1) presenter.present(jpeg(i));
    presenter.clear();
    runDeferred();
    // Every URL ever minted is accounted for: three revoked as they aged out,
    // two on the clear.
    expect(new Set(revoked)).toEqual(new Set(created));
  });

  it("does nothing on a clear with nothing outstanding", () => {
    const { presenter, deferredCount, revoked } = harness();
    presenter.clear();
    expect(deferredCount()).toBe(0);
    expect(revoked).toEqual([]);
  });

  it("keeps presenting after a clear", () => {
    const { presenter, created, revoked, runDeferred } = harness();
    presenter.present(jpeg(1));
    presenter.clear();
    runDeferred();
    const next = presenter.present(jpeg(2));
    expect(next).toBe(created[1]);
    // The cleared pair is forgotten, so nothing is double-revoked.
    presenter.present(jpeg(3));
    presenter.present(jpeg(4));
    expect(revoked.filter((url) => url === created[0])).toHaveLength(1);
  });

  /** Read a Blob's bytes back; jsdom's Blob has no `arrayBuffer()`. */
  async function bytesOf(blob: Blob): Promise<number[]> {
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    return [...new Uint8Array(buffer)];
  }

  it("hands over only the frame's own bytes, not its whole allocation", async () => {
    // A decoded frame is routinely a VIEW onto a larger pooled buffer. Handing
    // the Blob `jpeg.buffer` would give it the surrounding bytes too — a
    // corrupt image built from a frame that was itself perfectly fine.
    const blobs: Blob[] = [];
    const presenter = createFramePresenter({
      createUrl: (blob) => {
        blobs.push(blob);
        return `blob:${blobs.length}`;
      },
      revokeUrl: () => {},
      defer: (fn) => fn(),
    });
    const pool = new Uint8Array([9, 9, 9, 0xff, 0xd8, 0x42, 9, 9]);
    presenter.present(pool.subarray(3, 6));
    expect(await bytesOf(blobs[0]!)).toEqual([0xff, 0xd8, 0x42]);
  });

  it("hands the browser the bytes as they were, not a live view of them", async () => {
    // The decoder returns a slice of a socket buffer some transports reuse, so
    // the blob must hold the bytes AS OF `present`. Asserted by reading the
    // blob back: `size` and `type` are identical whether it copied or aliased,
    // so checking those proves nothing at all.
    const blobs: Blob[] = [];
    const presenter = createFramePresenter({
      createUrl: (blob) => {
        blobs.push(blob);
        return `blob:${blobs.length}`;
      },
      revokeUrl: () => {},
      defer: (fn) => fn(),
    });
    const bytes = jpeg(7);
    presenter.present(bytes);
    bytes[2] = 0x00;

    expect(await bytesOf(blobs[0]!)).toEqual([0xff, 0xd8, 0x07]);
    expect(blobs[0]!.type).toBe("image/jpeg");
  });

  it("defaults to real timers and the real URL factory", async () => {
    // The injected seams above must not be the only path that works.
    const createObjectURL = vi.fn(() => "blob:real");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    try {
      const presenter = createFramePresenter();
      expect(presenter.present(jpeg(1))).toBe("blob:real");
      presenter.clear();
      expect(revokeObjectURL).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:real");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
