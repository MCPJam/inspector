import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  webBodyLimit,
  DEFAULT_WEB_BODY_LIMIT,
  AUDIO_WEB_BODY_LIMIT,
} from "../web-body-limit";

function buildApp() {
  const app = new Hono();
  app.use("/api/web/*", webBodyLimit());
  // Handlers consume the body — hono's bodyLimit counts bytes as the stream
  // is read, so a handler that never reads would never trip the cap. (The
  // upload route's own 30MB cap is out of scope; we only assert which
  // requests the blanket middleware lets through.)
  const readBody = async (c: any) => {
    await c.req.text();
    return c.json({ ok: true });
  };
  app.post("/api/web/computers/upload", readBody);
  app.put("/api/web/computers/upload", readBody);
  app.post("/api/web/other", readBody);
  app.post("/api/web/audio/transcriptions", readBody);
  return app;
}

const OVERSIZED = "x".repeat(DEFAULT_WEB_BODY_LIMIT + 1);

describe("webBodyLimit", () => {
  it("caps ordinary /api/web routes at 1MB", async () => {
    const res = await buildApp().request("/api/web/other", {
      method: "POST",
      body: OVERSIZED,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("lets small bodies through", async () => {
    const res = await buildApp().request("/api/web/other", {
      method: "POST",
      body: JSON.stringify({ small: true }),
    });
    expect(res.status).toBe(200);
  });

  it("exempts POST to the computer upload route (it mounts its own cap)", async () => {
    const res = await buildApp().request("/api/web/computers/upload", {
      method: "POST",
      body: OVERSIZED,
    });
    expect(res.status).toBe(200);
  });

  it("does NOT exempt non-POST methods on the upload path", async () => {
    const res = await buildApp().request("/api/web/computers/upload", {
      method: "PUT",
      body: OVERSIZED,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  // The audio carve-out had no coverage at all before MJ-002, which is part of
  // why it sat at 25MB — a number nothing asserted and nothing explained.
  it("admits an audio body up to the audio cap", async () => {
    // 8MB clears 180s of 16-bit 16kHz mono WAV (~7.3MB base64) — the shape a
    // non-browser API caller is most likely to send — so it must transcribe.
    // The browser's own opus recording is ~1.8MB and nowhere near this.
    const res = await buildApp().request("/api/web/audio/transcriptions", {
      method: "POST",
      body: "x".repeat(8 * 1024 * 1024),
    });
    expect(res.status).toBe(200);
  });

  it("rejects an audio body past the audio cap", async () => {
    const res = await buildApp().request("/api/web/audio/transcriptions", {
      method: "POST",
      body: "x".repeat(AUDIO_WEB_BODY_LIMIT + 1),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Audio transcription body exceeds 10MB limit",
    });
  });

  it("keeps the audio carve-out scoped to the audio path", async () => {
    // A body that audio would admit must still be refused elsewhere — the
    // carve-out must not widen to the rest of /api/web/*.
    const res = await buildApp().request("/api/web/other", {
      method: "POST",
      body: "x".repeat(2 * 1024 * 1024),
    });
    expect(res.status).toBe(400);
  });
});
