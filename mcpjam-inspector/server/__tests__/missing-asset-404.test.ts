import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A tab still running an older build asks for that build's content-hashed
 * chunk after a deploy has replaced it. The static handler had nothing to
 * serve, so the request fell through to the SPA catch-all and came back as
 * index.html with a 200 — an import that "succeeds" with HTML fails later
 * with a less useful error than a plain 404 would.
 */

type App = { fetch: (request: Request) => Response | Promise<Response> };

const originalCwd = process.cwd();
let app: App;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpjam-assets-"));
  mkdirSync(join(dir, "dist", "client", "assets"), { recursive: true });
  writeFileSync(
    join(dir, "dist", "client", "index.html"),
    '<!doctype html><html><head><script type="module" src="/assets/index-new.js"></script></head><body></body></html>',
  );
  writeFileSync(
    join(dir, "dist", "client", "assets", "index-new.js"),
    "export {};",
  );
  process.chdir(dir);

  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "");
  vi.stubEnv("ELECTRON_APP", "");
  const { createHonoApp } = await import("../app.js");
  app = (await createHonoApp()).app;
}, 120_000);

afterAll(() => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
});

const get = (path: string) =>
  app.fetch(
    new Request(`http://localhost:6274${path}`, {
      headers: { Host: "localhost:6274" },
    }),
  );

describe("/assets/* for a chunk the served build no longer has", () => {
  it("serves an asset that exists", async () => {
    const response = await get("/assets/index-new.js");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("export");
  });

  it("returns 404 rather than the SPA document", async () => {
    const response = await get("/assets/trace-timeline-CtNEAoFZ.js");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("<html");
  });

  it("still serves the document for app routes", async () => {
    const response = await get("/evals");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("index-new.js");
  });
});
