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

function postBytes(app: Hono, path: string, size: number) {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(size),
    },
    body: new Uint8Array(size),
  });
}

describe("webBodyLimit", () => {
  it("sizes the skills upload carve-out from the service total cap", () => {
    expect(SKILLS_UPLOAD_BODY_LIMIT).toBeGreaterThan(DEFAULT_WEB_BODY_LIMIT);
  });

  it("rejects a >1MB body on a normal /api/web route", async () => {
    const res = await postBytes(appUnderTest(), "/api/web/other", 2 * 1024 * 1024);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("allows a multi-MB body on the skills folder-upload route", async () => {
    const res = await postBytes(
      appUnderTest(),
      "/api/web/skills/upload-folder",
      2 * 1024 * 1024, // > 1MB, well under the carve-out
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("still rejects a body over the skills carve-out", async () => {
    const res = await postBytes(
      appUnderTest(),
      "/api/web/skills/upload-folder",
      SKILLS_UPLOAD_BODY_LIMIT + 1024,
    );
    expect(res.status).toBe(400);
  });
});
