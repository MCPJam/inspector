import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A `web.use("/x/*")` in the `/api/web` sub-router runs in front of root-app
 * routes under the same prefix — including WebSockets it was never meant to
 * touch.
 *
 * A WS upgrade cannot be served from a Hono sub-router, so every socket under
 * `/api/web/...` is registered on the ROOT app in `server/index.ts` and
 * `server/app.ts`, and both files do that AFTER `app.route("/api/web", ...)`.
 * Hono composes matched handlers in registration order, so a prefix middleware
 * on the sub-router is in front of a socket registered later at a path it
 * covers. Those sockets authenticate with a token on `Sec-WebSocket-Protocol`
 * and carry no `Authorization` header, so a bearer middleware refuses the
 * upgrade and the client sees a bare 1006 with nothing to read.
 *
 * That is not hypothetical: `web.use("/webmcp/*", …, requireVerifiedAuth(), …)`,
 * added for the hosted WebMCP Inspector, silently killed the LOCAL viewport
 * frame stream at `/api/web/webmcp/sessions/:id/frames`. The middleware is
 * needed hosted and harmful locally, so it is gated on `HOSTED_MODE`; this test
 * exists so the next one is caught by CI rather than by a person watching a
 * blank viewport.
 *
 * SOURCE-TEXT, not import, for the reason `entrypoint-parity.test.ts` gives:
 * `index.ts` calls `serve()` at module scope, and importing the web router
 * drags in every route module in the product.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (...segments: string[]) =>
  readFileSync(resolve(here, "..", ...segments), "utf8");

/** Lines that sit inside an `if (HOSTED_MODE) {` block, by brace depth. */
function hostedGatedLines(source: string): Set<number> {
  const lines = source.split("\n");
  const gated = new Set<number>();
  let depth = 0;
  let gateDepth: number | null = null;
  lines.forEach((line, index) => {
    if (gateDepth !== null) gated.add(index);
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (gateDepth === null && /\bif\s*\(\s*HOSTED_MODE\s*\)\s*\{/.test(line)) {
      gateDepth = depth;
      gated.add(index);
    }
    depth += opens - closes;
    if (gateDepth !== null && depth <= gateDepth) gateDepth = null;
  });
  return gated;
}

/**
 * Prefixes of `web.use("/x/*", …)` calls that run in EVERY mode, as the
 * absolute paths they cover. An exact path (no trailing `*`) cannot shadow a
 * deeper route, so only globs are collected.
 */
function unconditionalWebPrefixes(source: string): string[] {
  const gated = hostedGatedLines(source);
  const lines = source.split("\n");
  const prefixes: string[] = [];
  lines.forEach((line, index) => {
    // Both the one-line form and the first line of a wrapped call, whose path
    // literal prettier puts on the following line.
    const inline = line.match(/\bweb\.use\(\s*"([^"]*)"/);
    const wrapped = /\bweb\.use\(\s*$/.test(line)
      ? lines[index + 1]?.match(/^\s*"([^"]*)"/)
      : null;
    const path = (inline ?? wrapped)?.[1];
    if (!path?.endsWith("/*")) return;
    if (gated.has(index)) return;
    prefixes.push(`/api/web${path.slice(0, -1)}`);
  });
  return prefixes;
}

/** Literal paths registered directly on the root app, wrapped calls included. */
function rootAppPaths(source: string): string[] {
  // One pattern covers both forms: `\s` matches newlines, so the wrapped call
  // prettier produces — the path literal on the line after `app.get(` — is
  // already caught here. A second newline-specific pattern only looked like it
  // was doing something.
  const pattern =
    /\bapp\.(?:route|use|get|post|put|patch|delete|options|all)\(\s*"([^"]*)"/g;
  const paths = new Set<string>();
  for (const match of source.matchAll(pattern)) paths.add(match[1]!);
  return [...paths].filter((path) => path.startsWith("/api/web/"));
}

describe("/api/web sub-router prefix middleware", () => {
  const webRouterSource = read("routes", "web", "index.ts");
  const prefixes = unconditionalWebPrefixes(webRouterSource);

  it("reads the router it is asserting about", () => {
    // The extraction is blunt on purpose. If it ever stops finding the
    // middleware this file exists to constrain, every assertion below passes
    // vacuously — so the count is pinned to something non-trivial.
    expect(prefixes.length).toBeGreaterThan(5);
    expect(prefixes).toContain("/api/web/servers/");
  });

  it("does not gate the hosted WebMCP Inspector in local mode", () => {
    // The specific regression: this prefix covers the local frame socket.
    expect(prefixes).not.toContain("/api/web/webmcp/");
  });

  for (const entrypoint of ["index.ts", "app.ts"] as const) {
    it(`shadows nothing the root app registers in ${entrypoint}`, () => {
      const shadowed = rootAppPaths(read(entrypoint)).flatMap((path) =>
        prefixes
          .filter((prefix) => path.startsWith(prefix))
          .map((prefix) => `${prefix}* shadows ${path}`),
      );
      expect(shadowed).toEqual([]);
    });
  }
});
