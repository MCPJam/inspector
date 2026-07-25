import { describe, it, expect, vi } from "vitest";
import {
  assertPluginBundleWithinCap,
  MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES,
  toPluginApiError,
  uploadPluginBundleToUrl,
} from "../plugin-api";
import { PluginApiError } from "../plugin-api-types";

function okJson(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
}

describe("uploadPluginBundleToUrl", () => {
  it("POSTs the bundle and returns the storage id", async () => {
    const fetchImpl = vi.fn(async () => okJson({ storageId: "st_123" }));
    const storageId = await uploadPluginBundleToUrl(
      "https://upload.example/x",
      new Uint8Array([1, 2, 3]),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(storageId).toBe("st_123");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://upload.example/x",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects an oversized bundle before uploading (backend cap mirror)", async () => {
    const fetchImpl = vi.fn();
    const oversized = {
      size: MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES + 1,
    } as unknown as Blob;
    Object.setPrototypeOf(oversized, Blob.prototype);
    await expect(
      uploadPluginBundleToUrl("https://upload.example/x", oversized, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "ARCHIVE_TOO_LARGE_COMPRESSED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a non-2xx response to UPLOAD_FAILED", async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 500 }) as unknown as Response,
    );
    await expect(
      uploadPluginBundleToUrl("https://upload.example/x", new Uint8Array([1]), {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
  });

  it("maps a missing storageId to UPLOAD_FAILED", async () => {
    const fetchImpl = vi.fn(async () => okJson({}));
    await expect(
      uploadPluginBundleToUrl("https://upload.example/x", new Uint8Array([1]), {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
  });

  it("rejects an empty-string storageId as UPLOAD_FAILED", async () => {
    const fetchImpl = vi.fn(async () => okJson({ storageId: "" }));
    await expect(
      uploadPluginBundleToUrl("https://upload.example/x", new Uint8Array([1]), {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
  });

  it("aborts a stalled upload after timeoutMs", async () => {
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
      uploadPluginBundleToUrl("https://upload.example/x", new Uint8Array([1]), {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_FAILED",
      message: expect.stringContaining("timed out"),
    });
  });
});

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
