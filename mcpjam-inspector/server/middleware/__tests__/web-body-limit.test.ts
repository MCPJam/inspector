import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  webBodyLimit,
  DEFAULT_WEB_BODY_LIMIT,
  SKILLS_UPLOAD_BODY_LIMIT,
} from "../web-body-limit";

// The carve-out exists so the cloud-skills service caps (5MB/20MB) are
// reachable: a blanket 1MB limit would 400 every skill upload first.

function appUnderTest() {
  const app = new Hono();
  app.use("/api/web/*", webBodyLimit());
  app.post("/api/web/skills/upload-folder", (c) => c.json({ ok: true }));
  app.post("/api/web/other", (c) => c.json({ ok: true }));
  return app;
}

function postBytes(
  app: Hono,
  path: string,
  size: number,
  contentType = "application/octet-stream",
) {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "content-length": String(size),
    },
    body: new Uint8Array(size),
  });
}

const MULTIPART = "multipart/form-data; boundary=----test";

describe("webBodyLimit", () => {
  it("sizes the skills upload carve-out from the service total cap", () => {
    expect(SKILLS_UPLOAD_BODY_LIMIT).toBeGreaterThan(DEFAULT_WEB_BODY_LIMIT);
  });

  it("rejects a >1MB body on a normal /api/web route", async () => {
    const res = await postBytes(appUnderTest(), "/api/web/other", 2 * 1024 * 1024);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("allows a multi-MB multipart body on the skills folder-upload route", async () => {
    const res = await postBytes(
      appUnderTest(),
      "/api/web/skills/upload-folder",
      2 * 1024 * 1024, // > 1MB, well under the carve-out
      MULTIPART,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("still rejects a multipart body over the skills carve-out", async () => {
    const res = await postBytes(
      appUnderTest(),
      "/api/web/skills/upload-folder",
      SKILLS_UPLOAD_BODY_LIMIT + 1024,
      MULTIPART,
    );
    expect(res.status).toBe(400);
  });

  it("does NOT extend the carve-out to a non-multipart request on that path", async () => {
    // A JSON (non-multipart) POST to the upload path keeps the default 1MB cap,
    // so the larger limit can't be abused by anything but a real upload.
    const res = await postBytes(
      appUnderTest(),
      "/api/web/skills/upload-folder",
      2 * 1024 * 1024,
      "application/json",
    );
    expect(res.status).toBe(400);
  });

  it("is not fooled by multipart/form-data appearing as a content-type param", async () => {
    // The media type must be compared exactly — a header whose media type is
    // application/json but carries `x=multipart/form-data` must keep the 1MB cap.
    const res = await postBytes(
      appUnderTest(),
      "/api/web/skills/upload-folder",
      2 * 1024 * 1024,
      "application/json; x=multipart/form-data",
    );
    expect(res.status).toBe(400);
  });
});
