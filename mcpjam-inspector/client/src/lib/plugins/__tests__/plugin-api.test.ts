import { describe, it, expect, vi } from "vitest";
import {
  assertPluginBundleWithinCap,
  MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES,
  toPluginApiError,
  uploadPluginBundleTracked,
} from "../plugin-api";
import { PluginApiError } from "../plugin-api-types";

describe("uploadPluginBundleTracked", () => {
  const baseArgs = {
    siteUrl: "https://demo.convex.site",
    projectId: "prj_123",
    bearerToken: "bearer-abc",
  };

  it("POSTs to the tracked route with the bearer and returns the storage id", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ ok: true, storageId: "st_tracked" }),
    );
    const storageId = await uploadPluginBundleTracked({
      ...baseArgs,
      bundle: new Blob(["zip-bytes"]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(storageId).toBe("st_tracked");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://demo.convex.site/plugin-bundle-upload?projectId=prj_123",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer bearer-abc",
        }),
      }),
    );
  });

  it("surfaces the route's stable error codes structurally", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: false,
          status: 429,
          json: async () => ({
            ok: false,
            code: "RATE_LIMITED",
            error: "Guest plugin uploads are busy right now. Try again later.",
          }),
        }) as unknown as Response,
    );
    await expect(
      uploadPluginBundleTracked({
        ...baseArgs,
        bundle: new Blob(["zip-bytes"]),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("rejects an oversized bundle before any network call", async () => {
    const fetchImpl = vi.fn();
    const oversized = new Uint8Array(MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES + 1);
    await expect(
      uploadPluginBundleTracked({
        ...baseArgs,
        bundle: oversized,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "ARCHIVE_TOO_LARGE_COMPRESSED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still uploads a zero-length bundle (the backend rejects it as a malformed archive)", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ ok: true, storageId: "st_empty" }),
    );
    const storageId = await uploadPluginBundleTracked({
      ...baseArgs,
      bundle: new Uint8Array(0),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(storageId).toBe("st_empty");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps a network failure to UPLOAD_FAILED with the cause", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      uploadPluginBundleTracked({
        ...baseArgs,
        bundle: new Blob(["zip-bytes"]),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_FAILED",
      message: expect.stringContaining("Failed to fetch"),
    });
  });

  it("maps a 2xx response without a storage id to UPLOAD_FAILED", async () => {
    const fetchImpl = vi.fn(async () => okJson({ ok: true }));
    await expect(
      uploadPluginBundleTracked({
        ...baseArgs,
        bundle: new Blob(["zip-bytes"]),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_FAILED",
      message: expect.stringContaining("storage id"),
    });
  });

  it("aborts when the response body stalls past timeoutMs", async () => {
    // fetch resolves on HEADERS; the abort timer must survive into the body
    // read, so a response whose json() never settles still times out.
    const fetchImpl = vi.fn(
      async (_url: string, init: RequestInit) =>
        ({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () =>
                reject(
                  new DOMException("The operation was aborted.", "AbortError"),
                ),
              );
            }),
        }) as unknown as Response,
    );
    await expect(
      uploadPluginBundleTracked({
        ...baseArgs,
        bundle: new Blob(["zip-bytes"]),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_FAILED",
      message: expect.stringContaining("timed out"),
    });
  });

  it("aborts a stalled request after timeoutMs", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            ),
          );
        }),
    );
    await expect(
      uploadPluginBundleTracked({
        ...baseArgs,
        bundle: new Blob(["zip-bytes"]),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_FAILED",
      message: expect.stringContaining("timed out"),
    });
  });
});

function okJson(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
}

describe("assertPluginBundleWithinCap", () => {
  it("accepts a bundle at the cap and rejects one byte over", () => {
    const atCap = {
      size: MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES,
    } as unknown as Blob;
    Object.setPrototypeOf(atCap, Blob.prototype);
    expect(() => assertPluginBundleWithinCap(atCap)).not.toThrow();

    const overCap = {
      size: MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES + 1,
    } as unknown as Blob;
    Object.setPrototypeOf(overCap, Blob.prototype);
    expect(() => assertPluginBundleWithinCap(overCap)).toThrow(PluginApiError);
  });
});

describe("toPluginApiError", () => {
  it("extracts stable code/message/scope/retryAfter from ConvexError data", () => {
    const err = toPluginApiError({
      data: {
        code: "RATE_LIMITED",
        message: "Too many plugin imports for this project. Try again later.",
        scope: "project",
        retryAfter: 1234,
      },
    });
    expect(err).toBeInstanceOf(PluginApiError);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.scope).toBe("project");
    expect(err.retryAfter).toBe(1234);
  });

  it("keeps details from structured backend failures", () => {
    const err = toPluginApiError({
      data: {
        code: "CONFLICT",
        message: "Import is not in a committable state",
        details: { status: "failed" },
      },
    });
    expect(err.code).toBe("CONFLICT");
    expect(err.details).toEqual({ status: "failed" });
  });

  it("passes PluginApiError through unchanged", () => {
    const original = new PluginApiError("PLUGINS_DISABLED", "off");
    expect(toPluginApiError(original)).toBe(original);
  });

  it("falls back to UNKNOWN and strips the request-id prefix for plain errors", () => {
    const err = toPluginApiError(new Error("[Request ID abc] Server Error"));
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toBe("Server Error");
  });
});
