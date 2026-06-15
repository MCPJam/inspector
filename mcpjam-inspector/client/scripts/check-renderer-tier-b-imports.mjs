#!/usr/bin/env node
/**
 * Tier-B import guard for the interactive widget renderer.
 *
 * Phase 1b inverts `mcp-apps-renderer.tsx`'s ambient inspector-app-state reads
 * (preferences / playground / chatbox / active-profile / host-context stores +
 * contexts, and the `client-config*` / `client-styles` resolvers) behind the
 * `useWidgetHost()` adapter (see ../src/components/chat-v2/thread/mcp-apps/
 * widget-host.ts + use-widget-host.ts). Once inverted, the renderer must import
 * ZERO inspector-app-state modules — that decoupling is what lets a later phase
 * relocate the renderer into a framework-free widget package.
 *
 * This guard fails (exit 1) if the renderer re-acquires a forbidden import. The
 * adapter (`use-widget-host.ts`) is EXEMPT: it is the inspector-side boundary
 * that legitimately owns these reads.
 *
 * Matching mirrors the requested "exact specifier, `bad/` subpath, or
 * path-segment" style: a forbidden entry `F` trips on `spec === F`,
 * `spec` starting with `F + "/"`, or `F` appearing as a full slash-delimited
 * segment of `spec`.
 *
 * Deliberately NOT forbidden (widget-runtime deps that relocate with the
 * renderer in a later phase): `@modelcontextprotocol/ext-apps`,
 * `@mcp-ui/client`, `@/components/ui/sandboxed-iframe`, `@mcpjam/sdk/*`, and
 * relative `./` sibling imports.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// File under guard (relative to client/).
const RENDERER_PATH = resolve(
  __dirname,
  "../src/components/chat-v2/thread/mcp-apps/mcp-apps-renderer.tsx",
);

/**
 * Inspector-app-state module specifiers (and prefixes) the renderer must not
 * import. The renderer reads all of these through `useWidgetHost()` instead.
 */
const FORBIDDEN = [
  "@/stores",
  "@/state",
  "@/contexts",
  "@/hooks",
  "@/lib/client-config",
  "@/lib/client-config-v2",
  "@/lib/client-styles",
  "@/lib/app-navigation",
  "@/lib/host-capabilities",
  "convex",
  "posthog-js",
  "@mcpjam/design-system",
];

/**
 * Returns the forbidden entry a specifier matches, or null.
 *   - exact:        spec === F
 *   - bad/ subpath: spec startsWith F + "/"
 *   - path-segment: F is a full "/"-delimited segment of spec
 */
function matchForbidden(spec) {
  for (const f of FORBIDDEN) {
    if (spec === f) return f;
    if (spec.startsWith(`${f}/`)) return f;
    // Path-segment: catches e.g. `convex` inside `x/convex/y`. Anchored on
    // segment boundaries so `@/lib/client-configuration` does NOT match
    // `@/lib/client-config`.
    const segments = spec.split("/");
    if (segments.includes(f)) return f;
    // Multi-segment forbidden entries (e.g. `@/lib/client-config`) checked as a
    // contiguous run of segments.
    if (f.includes("/")) {
      const fSegs = f.split("/");
      for (let i = 0; i + fSegs.length <= segments.length; i += 1) {
        if (fSegs.every((s, j) => segments[i + j] === s)) return f;
      }
    }
  }
  return null;
}

/**
 * Extract every import/export module specifier from a TS/TSX source.
 * Covers: `import ... from "x"`, side-effect `import "x"`, `export ... from
 * "x"`, and dynamic `import("x")`.
 */
function extractSpecifiers(source) {
  const specs = [];
  const patterns = [
    /\bimport\s+[^;'"]*?\bfrom\s*["']([^"']+)["']/g, // import ... from "x"
    /\bexport\s+[^;'"]*?\bfrom\s*["']([^"']+)["']/g, // export ... from "x"
    /\bimport\s*["']([^"']+)["']/g, // side-effect import "x"
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("x")
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
  }
  return specs;
}

function main() {
  let source;
  try {
    source = readFileSync(RENDERER_PATH, "utf8");
  } catch (err) {
    console.error(
      `[tier-b-guard] could not read renderer at ${RENDERER_PATH}: ${err.message}`,
    );
    process.exit(2);
  }

  const violations = [];
  for (const spec of extractSpecifiers(source)) {
    const hit = matchForbidden(spec);
    if (hit) violations.push({ spec, rule: hit });
  }

  if (violations.length > 0) {
    console.error(
      "[tier-b-guard] mcp-apps-renderer.tsx imports forbidden inspector-app-state modules.",
    );
    console.error(
      "  The renderer must read these through useWidgetHost() (see widget-host.ts / use-widget-host.ts).",
    );
    for (const v of violations) {
      console.error(`  - "${v.spec}"  (matched forbidden rule: "${v.rule}")`);
    }
    process.exit(1);
  }

  console.log(
    "[tier-b-guard] OK: mcp-apps-renderer.tsx imports no forbidden inspector-app-state modules.",
  );
}

main();
