import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import v1Routes from "../index.js";

// Guards docs/reference/openapi.json against drift from the actual Hono router.
// The spec is hand-authored, so nothing otherwise stops a route from being
// added/removed/renamed without a matching spec edit (the removed `force`
// delete param is the cautionary tale). This builds a route inventory from the
// mounted app and diffs it against the spec's paths+methods in BOTH directions.

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(
  readFileSync(
    resolve(here, "../../../../../docs/reference/openapi.json"),
    "utf8"
  )
) as {
  security?: unknown[];
  paths: Record<
    string,
    Record<
      string,
      { operationId?: string; requestBody?: unknown; security?: unknown[] }
    >
  >;
};

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// POST actions that intentionally carry no request body (so the requestBody
// assertion below doesn't flag them). Keep this list tiny and explicit.
const BODYLESS_WRITES = new Set([
  "post /projects/{projectId}/tunnels/{serverId}/close",
]);

// Pre-existing documentation gap: routes that the v1 router serves but that the
// hand-authored openapi.json does not describe yet (the eval-suite/case
// management surface and the SDK eval-ingest transport). The drift check fails
// on any NEW undocumented route; these are baselined so the guard can land now
// and the spec be backfilled separately. The test also keeps this list tight —
// documenting or deleting a route must remove its entry here.
const KNOWN_UNDOCUMENTED = new Set([
  "get /projects/{projectId}/eval-suites/{suiteId}",
  "patch /projects/{projectId}/eval-suites/{suiteId}",
  "delete /projects/{projectId}/eval-suites/{suiteId}",
  "patch /projects/{projectId}/eval-suites/{suiteId}/schedule",
  "get /projects/{projectId}/eval-suites/{suiteId}/cases",
  "post /projects/{projectId}/eval-suites/{suiteId}/cases",
  "post /projects/{projectId}/eval-suites/{suiteId}/cases/generate",
  "get /projects/{projectId}/eval-suites/{suiteId}/cases/{caseId}",
  "patch /projects/{projectId}/eval-suites/{suiteId}/cases/{caseId}",
  "delete /projects/{projectId}/eval-suites/{suiteId}/cases/{caseId}",
  "post /projects/{projectId}/eval-ingest/runs/start",
  "post /projects/{projectId}/eval-ingest/runs/iterations",
  "post /projects/{projectId}/eval-ingest/runs/finalize",
  "post /projects/{projectId}/eval-ingest/report",
  "post /projects/{projectId}/eval-ingest/artifacts/upload-url",
]);

/** Hono `:param` + the `/api/v1` mount prefix -> OpenAPI `{param}`, unprefixed. */
function normalizePath(path: string): string {
  return path.replace(/^\/api\/v1/, "").replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** `{ method, path }` keys for every real HTTP route the v1 router serves. */
function appInventory(): Set<string> {
  const inventory = new Set<string>();
  for (const route of v1Routes.routes) {
    const method = route.method.toUpperCase();
    // Skip middleware (registered as `ALL` via `.use("*")`) and non-HTTP verbs.
    if (!HTTP_METHODS.has(method)) continue;
    inventory.add(`${method.toLowerCase()} ${normalizePath(route.path)}`);
  }
  return inventory;
}

/** `{ method, path }` keys for every operation the spec documents. */
function specInventory(): Set<string> {
  const inventory = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (!HTTP_METHODS.has(method.toUpperCase())) continue;
      inventory.add(`${method.toLowerCase()} ${path}`);
    }
  }
  return inventory;
}

describe("openapi.json ↔ /api/v1 route parity", () => {
  const appRoutes = appInventory();
  const specRoutes = specInventory();

  it("documents every route the router serves (modulo the baselined backlog)", () => {
    const undocumented = [...appRoutes].filter((r) => !specRoutes.has(r));

    const newlyUndocumented = undocumented
      .filter((r) => !KNOWN_UNDOCUMENTED.has(r))
      .sort();
    expect(
      newlyUndocumented,
      `New /api/v1 routes missing from openapi.json — document them (or, if intentionally internal, add to KNOWN_UNDOCUMENTED with a reason):\n  ${newlyUndocumented.join(
        "\n  "
      )}`
    ).toEqual([]);

    // Keep the baseline honest: a baselined route that is now documented or
    // removed should be dropped from KNOWN_UNDOCUMENTED.
    const staleBaseline = [...KNOWN_UNDOCUMENTED]
      .filter((r) => !undocumented.includes(r))
      .sort();
    expect(
      staleBaseline,
      `Stale KNOWN_UNDOCUMENTED entries (now documented or gone) — remove them:\n  ${staleBaseline.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("documents only routes that exist (no phantom spec entries)", () => {
    const phantom = [...specRoutes].filter((r) => !appRoutes.has(r)).sort();
    expect(
      phantom,
      `openapi.json documents paths/methods with no matching route:\n  ${phantom.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("requires bearerAuth security globally or per operation", () => {
    const hasBearer = (entries: unknown): boolean =>
      Array.isArray(entries) &&
      entries.some(
        (entry) =>
          !!entry &&
          typeof entry === "object" &&
          "bearerAuth" in (entry as Record<string, unknown>)
      );
    const globalBearer = hasBearer(spec.security);
    const missing: string[] = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!HTTP_METHODS.has(method.toUpperCase())) continue;
        if (!globalBearer && !hasBearer(op.security)) {
          missing.push(`${method} ${path}`);
        }
      }
    }
    expect(
      missing,
      `Operations without a bearerAuth security requirement:\n  ${missing.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("gives every operation an operationId", () => {
    const missing: string[] = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!HTTP_METHODS.has(method.toUpperCase())) continue;
        if (!op.operationId) missing.push(`${method} ${path}`);
      }
    }
    expect(missing, `Operations missing operationId:\n  ${missing.join("\n  ")}`).toEqual(
      []
    );
  });

  it("declares a requestBody for create/update writes", () => {
    const missing: string[] = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (method !== "post" && method !== "patch" && method !== "put") {
          continue;
        }
        const key = `${method} ${path}`;
        if (!op.requestBody && !BODYLESS_WRITES.has(key)) missing.push(key);
      }
    }
    expect(
      missing,
      `Write operations missing a requestBody (add one, or allowlist a genuinely bodyless action):\n  ${missing.join(
        "\n  "
      )}`
    ).toEqual([]);
  });
});
