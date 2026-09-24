import { describe, expect, it, vi } from "vitest";
import {
  IMAGE_SIZE_MESSAGE,
  IMAGE_TYPE_MESSAGE,
  IMAGE_UPLOAD_ACCEPT,
  ImageUploadError,
  MAX_IMAGE_UPLOAD_BYTES,
  uploadImage,
  validateImageFile,
} from "../image-upload";

const png = () =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "photo.png", {
    type: "image/png",
  });

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("validateImageFile", () => {
  it("accepts PNG, JPEG, GIF and WebP", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(validateImageFile({ type, size: 1 })).toBeNull();
    }
    expect(IMAGE_UPLOAD_ACCEPT).toBe(
      "image/png,image/jpeg,image/gif,image/webp",
    );
  });

  it("refuses SVG and every other type with one clear message", () => {
    for (const type of ["image/svg+xml", "text/html", "image/avif", ""]) {
      expect(validateImageFile({ type, size: 1 })).toBe(IMAGE_TYPE_MESSAGE);
    }
  });

  it("refuses images over 5 MB", () => {
    expect(
      validateImageFile({
        type: "image/png",
        size: MAX_IMAGE_UPLOAD_BYTES + 1,
      }),
    ).toBe(IMAGE_SIZE_MESSAGE);
    expect(
      validateImageFile({ type: "image/png", size: MAX_IMAGE_UPLOAD_BYTES }),
    ).toBeNull();
  });
});

describe("uploadImage", () => {
  it("posts the file to the profile-picture route with the bearer", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ok: true, url: "https://files.example/p.png" }),
    );
    const file = png();

    const result = await uploadImage({
      siteUrl: "https://demo.convex.site/",
      bearerToken: "token-1",
      target: { kind: "profile-picture" },
      file,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ url: "https://files.example/p.png" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(String(url)).toBe(
      "https://demo.convex.site/web/uploads/profile-picture",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe(file);
    expect(init.headers).toEqual({
      "Content-Type": "image/png",
      Authorization: "Bearer token-1",
    });
  });

  it("names the organization for a logo upload", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));

    await uploadImage({
      siteUrl: "https://demo.convex.site",
      bearerToken: "token-1",
      target: { kind: "organization-logo", organizationId: "org 1" },
      file: png(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [url] = fetchImpl.mock.calls[0] as unknown as [URL];
    expect(String(url)).toBe(
      "https://demo.convex.site/web/uploads/organization-logo?organizationId=org+1",
    );
  });

  it("refuses an invalid file without a request", async () => {
    const fetchImpl = vi.fn();
    const svg = new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });

    await expect(
      uploadImage({
        siteUrl: "https://demo.convex.site",
        bearerToken: "token-1",
        target: { kind: "profile-picture" },
        file: svg,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ message: IMAGE_TYPE_MESSAGE });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces the server's refusal message and code", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(415, {
        ok: false,
        code: "UNSUPPORTED_MEDIA_TYPE",
        error: "Choose a PNG, JPEG, GIF, or WebP image.",
      }),
    );

    const failure = await uploadImage({
      siteUrl: "https://demo.convex.site",
      bearerToken: "token-1",
      target: { kind: "profile-picture" },
      file: png(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ImageUploadError);
    expect(failure).toMatchObject({
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "Choose a PNG, JPEG, GIF, or WebP image.",
    });
  });

  it("falls back to a generic message when the request or body fails", async () => {
    const networkDown = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      uploadImage({
        siteUrl: "https://demo.convex.site",
        bearerToken: "token-1",
        target: { kind: "profile-picture" },
        file: png(),
        fetchImpl: networkDown as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      message: "The image could not be uploaded. Try again.",
    });

    const htmlError = vi.fn(
      async () => new Response("<html>bad gateway</html>", { status: 502 }),
    );
    await expect(
      uploadImage({
        siteUrl: "https://demo.convex.site",
        bearerToken: "token-1",
        target: { kind: "profile-picture" },
        file: png(),
        fetchImpl: htmlError as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      status: 502,
      message: "The image could not be uploaded. Try again.",
    });
  });
});
