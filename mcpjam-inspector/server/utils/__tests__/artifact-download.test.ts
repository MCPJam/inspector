import { describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_RANGE_BYTES,
  downloadArtifactBytes,
  openArtifactDownload,
} from "../artifact-download.js";

const URL = "https://synthetic.convex.site/web/artifact?t=synthetic";
function partial(bytes: number[], range: string): Response {
  return new Response(new Uint8Array(bytes), {
    status: 206,
    headers: { "Content-Range": range },
  });
}
function queued(...responses: Response[]): typeof fetch {
  return vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    return response;
  });
}

describe("bounded artifact downloads", () => {
  it("assembles contiguous chunks without forwarding credentials or permitting redirects", async () => {
    const fetchImpl = queued(
      partial([1, 2], "bytes 0-1/5"),
      partial([3, 4, 5], "bytes 2-4/5"),
    );
    expect(
      await downloadArtifactBytes(URL, { fetchImpl, maxBytes: 5 }),
    ).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      URL,
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      URL,
      expect.objectContaining({
        headers: { Range: `bytes=2-${ARTIFACT_RANGE_BYTES + 1}` },
        redirect: "error",
      }),
    );
    expect(vi.mocked(fetchImpl).mock.calls[0][1]?.headers).toBeUndefined();
  });

  it("assembles a file larger than the full-response limit using capped chunks", async () => {
    const total = 21 * 1024 * 1024;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const header = new Headers(init?.headers).get("Range");
        const start = header ? Number(/^bytes=(\d+)-/.exec(header)?.[1]) : 0;
        const end = Math.min(start + ARTIFACT_RANGE_BYTES, total);
        return new Response(
          new Uint8Array(end - start).fill(start / ARTIFACT_RANGE_BYTES + 1),
          {
            status: 206,
            headers: { "Content-Range": `bytes ${start}-${end - 1}/${total}` },
          },
        );
      },
    );
    const result = await downloadArtifactBytes(URL, {
      fetchImpl,
      maxBytes: 30 * 1024 * 1024,
    });
    expect(result.byteLength).toBe(total);
    expect(result[0]).toBe(1);
    expect(result[ARTIFACT_RANGE_BYTES]).toBe(2);
    expect(result[total - 1]).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["gap", "bytes 3-4/5", [3, 4]],
    ["overlap", "bytes 1-4/5", [3, 4, 5, 6]],
    ["changed total", "bytes 2-4/6", [3, 4, 5]],
    ["wildcard total", "bytes 2-4/*", [3, 4, 5]],
    ["truncated", "bytes 2-4/5", [3]],
    ["extra bytes", "bytes 2-4/5", [3, 4, 5, 6]],
  ])(
    "rejects %s rather than returning a partial archive",
    async (_label, range, bytes) => {
      const fetchImpl = queued(
        partial([1, 2], "bytes 0-1/5"),
        partial(bytes, range),
      );
      await expect(
        downloadArtifactBytes(URL, { fetchImpl, maxBytes: 8 }),
      ).rejects.toThrow(/Artifact/);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it("stops on lifecycle revocation between chunks without raw fallback", async () => {
    const fetchImpl = queued(
      partial([1, 2], "bytes 0-1/5"),
      new Response("gone", { status: 404 }),
    );
    await expect(
      downloadArtifactBytes(URL, { fetchImpl, maxBytes: 8 }),
    ).rejects.toThrow("404");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects 200 on a continuation range", async () => {
    await expect(
      downloadArtifactBytes(URL, {
        maxBytes: 8,
        fetchImpl: queued(
          partial([1, 2], "bytes 0-1/5"),
          new Response(new Uint8Array([3, 4, 5])),
        ),
      }),
    ).rejects.toThrow("200");
  });

  it.each([
    new Response(new Uint8Array([1]), { headers: { "Content-Length": "9" } }),
    partial([1], "bytes 0-0/9"),
    partial([1], `bytes 0-${ARTIFACT_RANGE_BYTES}/${ARTIFACT_RANGE_BYTES + 1}`),
    new Response(new Uint8Array([1]), { status: 206 }),
  ])(
    "rejects invalid or oversized metadata before returning a stream",
    async (response) => {
      await expect(
        openArtifactDownload(URL, { maxBytes: 8, fetchImpl: queued(response) }),
      ).rejects.toThrow(/Artifact/);
    },
  );

  it("enforces actual size when Content-Length is absent", async () => {
    await expect(
      downloadArtifactBytes(URL, {
        maxBytes: 2,
        fetchImpl: queued(new Response(new Uint8Array([1, 2, 3]))),
      }),
    ).rejects.toThrow(/bounded size/);
  });

  it("rejects a truncated full response and encoded ranges", async () => {
    await expect(
      downloadArtifactBytes(URL, {
        maxBytes: 8,
        fetchImpl: queued(
          new Response(new Uint8Array([1]), {
            headers: { "Content-Length": "2" },
          }),
        ),
      }),
    ).rejects.toThrow(/truncated/);
    await expect(
      openArtifactDownload(URL, {
        maxBytes: 8,
        fetchImpl: queued(
          new Response("encoded", {
            status: 206,
            headers: {
              "Content-Encoding": "gzip",
              "Content-Range": "bytes 0-6/7",
            },
          }),
        ),
      }),
    ).rejects.toThrow(/encoding/);
  });

  it("preserves decoded full responses without trusting their encoded length", async () => {
    const fetchImpl = queued(
      new Response(new Uint8Array([1, 2]), {
        headers: { "Content-Encoding": "gzip", "Content-Length": "999" },
      }),
    );
    expect(
      await downloadArtifactBytes(URL, { fetchImpl, maxBytes: 2 }),
    ).toEqual(new Uint8Array([1, 2]));
  });

  it("sanitizes stream transport diagnostics", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("failed secret access link"));
      },
    });
    await expect(
      downloadArtifactBytes(URL, {
        maxBytes: 8,
        fetchImpl: queued(new Response(upstream)),
      }),
    ).rejects.toThrow("Artifact body transfer failed");
  });

  it("cancels the current upstream read", async () => {
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    const { body } = await openArtifactDownload(URL, {
      maxBytes: 8,
      fetchImpl: queued(new Response(upstream)),
    });
    const reader = body.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
