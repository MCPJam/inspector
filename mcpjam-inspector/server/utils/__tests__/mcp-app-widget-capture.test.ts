import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import {
  uploadScreenshotBlob,
  uploadVideoBlob,
} from "../mcp-app-widget-capture.js";

function makeClient(uploadUrl: unknown): {
  client: ConvexHttpClient;
  mutation: ReturnType<typeof vi.fn>;
} {
  const mutation = vi.fn(async () => uploadUrl);
  return { client: { mutation } as unknown as ConvexHttpClient, mutation };
}

// Duck-typed Response so the test doesn't depend on a global `Response`.
const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});
const errStatus = (status: number) => ({
  ok: false,
  status,
  json: async () => null,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("uploadScreenshotBlob", () => {
  test("POSTs an image/png blob and returns the storageId", async () => {
    const { client, mutation } = makeClient("https://convex.example/upload");
    const fetchMock = vi.fn(async () => okJson({ storageId: "store-1" }));
    vi.stubGlobal("fetch", fetchMock);

    // PNG base64 begins with "iVBOR"; not "/9j/" so it's detected as PNG.
    const id = await uploadScreenshotBlob(client, "iVBORw0KGgo");

    expect(id).toBe("store-1");
    expect(mutation).toHaveBeenCalledWith(
      "chatSessions:generateSnapshotUploadUrl",
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://convex.example/upload");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "image/png",
    );
    expect((init.body as Blob).type).toBe("image/png");
  });

  test("detects image/jpeg from the base64 header", async () => {
    const { client } = makeClient("https://convex.example/upload");
    const fetchMock = vi.fn(async () => okJson({ storageId: "store-2" }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadScreenshotBlob(client, "/9j/4AAQSkZJRg");

    const [, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "image/jpeg",
    );
  });

  test("returns undefined when the upload URL can't be generated (no fetch)", async () => {
    const { client } = makeClient("");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await uploadScreenshotBlob(client, "iVBORw0")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("throws on a non-2xx upload response", async () => {
    const { client } = makeClient("https://convex.example/upload");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errStatus(500)),
    );

    await expect(uploadScreenshotBlob(client, "iVBORw0")).rejects.toThrow(/500/);
  });

  test("returns undefined when the response body lacks a storageId", async () => {
    const { client } = makeClient("https://convex.example/upload");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({})),
    );

    expect(await uploadScreenshotBlob(client, "iVBORw0")).toBeUndefined();
  });
});

describe("uploadVideoBlob", () => {
  test("POSTs a video/webm blob and returns the storageId", async () => {
    const { client, mutation } = makeClient("https://convex.example/upload");
    const fetchMock = vi.fn(async () => okJson({ storageId: "vid-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const id = await uploadVideoBlob(client, Buffer.from([0x1a, 0x45, 0xdf]));

    expect(id).toBe("vid-1");
    expect(mutation).toHaveBeenCalledWith(
      "chatSessions:generateSnapshotUploadUrl",
      {},
    );
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://convex.example/upload");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "video/webm",
    );
    expect((init.body as Blob).type).toBe("video/webm");
  });

  test("returns undefined when the upload URL can't be generated (no fetch)", async () => {
    const { client } = makeClient("");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await uploadVideoBlob(client, Buffer.from([1]))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("throws on a non-2xx upload response", async () => {
    const { client } = makeClient("https://convex.example/upload");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errStatus(500)),
    );

    await expect(uploadVideoBlob(client, Buffer.from([1]))).rejects.toThrow(
      /500/,
    );
  });
});
