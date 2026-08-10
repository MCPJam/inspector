import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `server/index.ts` and `server/app.ts` must mount the same things.
 *
 * They are two entry points into one product — `index.ts` for the standalone
 * server, `app.ts` for Electron and embedded hosts — and every route, every
 * middleware, every registration has to be added to BOTH. Nothing enforced
 * that, and the failure is silent by construction: the standalone server keeps
 * working, so a route added to only one file looks fine until someone opens
 * the desktop app and finds a 404.
 *
 * That is not hypothetical. `mayServeSessionToken` — the single decision point
 * that keeps the session token off tunnel hosts — was used by `index.ts` and
 * NOT by `app.ts`, which called the raw allowlist instead and never read
 * `X-Forwarded-Host`. Both files now go through it, and the last assertion
 * here locks that in permanently.
 *
 * SOURCE-TEXT, not import. `index.ts` calls `serve()` at module scope: importing
 * it binds a port. Reading the files is the honest way to compare them, and it
 * is why the extraction below is deliberately blunt — it matches the literal
 * shapes these files actually use rather than trying to parse TypeScript.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(resolve(here, "..", name), "utf8");

/**
 * Path literals from `app.<verb>("...")` calls.
 *
 * Only string literals: a computed path would be invisible here, which is a
 * limitation worth knowing rather than working around — neither file has one,
 * and a future one should be written as a literal precisely so this can see it.
 */
function mountedPaths(source: string): Set<string> {
  const pattern =
    /\bapp\.(?:route|use|get|post|put|patch|delete|options|all)\(\s*"([^"]*)"/g;
  const paths = new Set<string>();
  for (const match of source.matchAll(pattern)) paths.add(match[1]!);
  return paths;
}

/** `registerFoo(app)` / `mountBar(app)` wiring calls. */
function registrations(source: string): Set<string> {
  const pattern = /\b((?:register|mount)[A-Z]\w*)\s*\(/g;
  const names = new Set<string>();
  for (const match of source.matchAll(pattern)) names.add(match[1]!);
  return names;
}

/**
 * Paths that live in ONE entry point on purpose.
 *
 * Written out, with the reason, because "these two files differ" is only
 * interesting when the difference is unexplained. Adding an entry here is a
 * decision that the desktop app does not need something (or that the
 * standalone server does not) — not a way to quiet the test.
 */
const INDEX_ONLY: Readonly<Record<string, string>> = {
  "/api/shutdown":
    "Stops the standalone server process. Electron owns its own lifecycle and quits through the app menu; exposing a shutdown route inside it would let a page kill the window's backend.",
  "/api/mcp-cli-config":
    "Emits the config blob `mcpjam` writes into a local MCP client. Only meaningful for the CLI-launched server — the desktop app is not something a CLI points a client at.",
};

const APP_ONLY: Readonly<Record<string, string>> = {
  "/guest/jwks":
    "Publishes the guest-token public keys. The standalone server serves this from the hosted deployment's Convex surface instead, so mounting it here would be a second, divergent source for the same key set.",
};

describe("server/index.ts <-> server/app.ts parity", () => {
  const indexSource = read("index.ts");
  const appSource = read("app.ts");

  const indexPaths = mountedPaths(indexSource);
  const appPaths = mountedPaths(appSource);

  it("extracts something — a silent regex failure would pass everything", () => {
    // Without this, a refactor that changes the call shape turns the whole
    // file into a test that compares two empty sets and always passes.
    expect(indexPaths.size).toBeGreaterThan(15);
    expect(appPaths.size).toBeGreaterThan(15);
    expect(registrations(indexSource).size).toBeGreaterThan(2);
  });

  it("mounts the same paths, modulo the declared singletons", () => {
    const missingFromApp = [...indexPaths]
      .filter((path) => !appPaths.has(path) && !(path in INDEX_ONLY))
      .sort();
    expect(
      missingFromApp,
      `Mounted in server/index.ts but NOT server/app.ts — the desktop/embedded app will 404 on these. Mount them there too, or add an INDEX_ONLY reason:\n  ${missingFromApp.join(
        "\n  "
      )}`
    ).toEqual([]);

    const missingFromIndex = [...appPaths]
      .filter((path) => !indexPaths.has(path) && !(path in APP_ONLY))
      .sort();
    expect(
      missingFromIndex,
      `Mounted in server/app.ts but NOT server/index.ts — the standalone server will 404 on these. Mount them there too, or add an APP_ONLY reason:\n  ${missingFromIndex.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("has no stale singleton entries", () => {
    const staleIndexOnly = Object.keys(INDEX_ONLY)
      .filter((path) => !indexPaths.has(path) || appPaths.has(path))
      .sort();
    expect(
      staleIndexOnly,
      `INDEX_ONLY entries that are gone, or that app.ts now mounts too — remove them:\n  ${staleIndexOnly.join(
        "\n  "
      )}`
    ).toEqual([]);

    const staleAppOnly = Object.keys(APP_ONLY)
      .filter((path) => !appPaths.has(path) || indexPaths.has(path))
      .sort();
    expect(
      staleAppOnly,
      `APP_ONLY entries that are gone, or that index.ts now mounts too — remove them:\n  ${staleAppOnly.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("wires the same register*/mount* calls", () => {
    const indexRegistrations = registrations(indexSource);
    const appRegistrations = registrations(appSource);
    const onlyIndex = [...indexRegistrations]
      .filter((name) => !appRegistrations.has(name))
      .sort();
    const onlyApp = [...appRegistrations]
      .filter((name) => !indexRegistrations.has(name))
      .sort();
    expect(
      { onlyIndex, onlyApp },
      "One entry point wires a registration the other does not."
    ).toEqual({ onlyIndex: [], onlyApp: [] });
  });

  it("BOTH entry points go through mayServeSessionToken", () => {
    // The specific regression this file exists to prevent from recurring.
    // `app.ts` used `isAllowedHost` — the same allowlist WITHOUT the tunnel
    // veto — so the session token could be served to a tunnel host through the
    // desktop/embedded entry while the standalone server correctly refused.
    for (const [name, source] of [
      ["server/index.ts", indexSource],
      ["server/app.ts", appSource],
    ] as const) {
      expect(
        source.includes("mayServeSessionToken"),
        `${name} must decide session-token delivery through mayServeSessionToken, which vetoes tunnel hosts BEFORE consulting the allowlist. Calling isAllowedHost directly reintroduces the leak.`
      ).toBe(true);
    }
  });
});
