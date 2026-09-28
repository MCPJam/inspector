import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * Ratchet for MJ-006 on the server: no `/api/web/*` route answers with an
 * upload URL. Byte uploads either go from the browser straight to the
 * backend's upload route, or through `POST /browser-profiles/upload`, which
 * takes the archive's bytes and answers with a storage id.
 *
 * If this fails because you added an upload: take the bytes and return the
 * storage id, the way `browser-profile-upload.ts` does.
 */

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: vi.fn(async () => ({ valid: false })),
}));

import webRoutes from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(here, "../../..");

/** Convex upload-URL mutations. */
const ISSUER_MUTATION_PATTERN = /\bgenerate[A-Za-z]*UploadUrl\b/;
/** Backend HTTP routes that hand an upload URL to their caller. */
const ISSUER_ROUTE_PATTERN = /["'`/][A-Za-z0-9/_-]*upload-url\b/;

/**
 * Files allowed to name an issuer route, each with the reason.
 */
const ISSUER_ROUTE_ALLOWED = new Map([
  [
    "routes/web/browser-profile-upload.ts",
    "asks the backend where to store an archive on the caller's behalf, streams the bytes there, and returns only the storage id",
  ],
  [
    "routes/v1/eval-ingest.ts",
    "API-key ingestion proxy, not /api/web; passes the backend's answer through for older SDK releases",
  ],
  [
    "utils/mcp-app-widget-capture.ts",
    "asks the backend where to store a replay video on the user's behalf, uploads it, and keeps only the storage id",
  ],
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "__tests__" ||
        entry.name === "dist"
      ) {
        continue;
      }
      out.push(...sourceFiles(full));
    } else if (/\.ts$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function serverFilesMatching(pattern: RegExp): string[] {
  return sourceFiles(SERVER_ROOT)
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(SERVER_ROOT, file).split(sep).join("/"))
    .sort();
}

describe("/api/web byte uploads (MJ-006)", () => {
  it("mounts no route that answers with an upload URL", () => {
    const routes = webRoutes.routes.map(
      (route) => `${route.method} ${route.path}`,
    );

    expect(routes.filter((route) => /upload-url/.test(route))).toEqual([]);
    expect(routes).toContain("POST /browser-profiles/upload");
  });

  it("calls no upload-URL mutation from server code", () => {
    expect(serverFilesMatching(ISSUER_MUTATION_PATTERN)).toEqual([]);
  });

  it("names an upload-URL route only in the allowlisted server modules", () => {
    expect(serverFilesMatching(ISSUER_ROUTE_PATTERN)).toEqual(
      [...ISSUER_ROUTE_ALLOWED.keys()].sort(),
    );
  });
});
