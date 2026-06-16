#!/usr/bin/env node
/**
 * Tier-B import guard for the inspector-side widget-runtime glue.
 *
 * As of Phase 3d-ii-c the interactive renderer cluster (renderer, modal,
 * surfaces, sandboxed-iframe, file-message bridge, app-tools registry,
 * tool-input streaming) has RELOCATED into `@mcpjam/widget-react`, where the
 * package's own `scripts/check-tier-imports.mjs` enforces it imports zero `@/`
 * inspector internals. The renderer reads inspector app-state only through the
 * `WidgetHost` contract, supplied via `<InspectorWidgetHostProvider>`
 * (use-widget-host.tsx) — the one module that legitimately owns those reads.
 *
 * What stays in the inspector is thin routing/util glue. This guard keeps that
 * glue from re-acquiring direct inspector-app-state imports (it must reach state
 * through the provider/host, not ad-hoc store/context reads). It fails (exit 1)
 * if any guarded file (see GUARDED_FILES) imports a forbidden module.
 *
 * Matching mirrors the requested "exact specifier, `bad/` subpath, or
 * path-segment" style: a forbidden entry `F` trips on `spec === F`,
 * `spec` starting with `F + "/"`, or `F` appearing as a full slash-delimited
 * segment of `spec`.
 *
 * Deliberately NOT forbidden: `@mcpjam/widget-react` (the package the glue
 * delegates to), `@mcpjam/sdk/*`, `@modelcontextprotocol/*`, `@mcp-ui/client`,
 * and relative `./` sibling imports.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Inspector-side widget glue under guard (relative to client/). The renderer
// cluster itself now lives in `@mcpjam/widget-react` (guarded there); these are
// the thin inspector files that route into it and must not reach into app-state
// directly — they go through `<InspectorWidgetHostProvider>` / the host. The
// adapter (`use-widget-host.tsx`) and renderer-path glue (`part-switch.tsx`) are
// NOT listed: they legitimately own the inspector-state reads.
const GUARDED_FILES = [
  "src/components/chat-v2/thread/widget-replay.tsx",
  "src/lib/mcp-ui/mcp-apps-utils.ts",
].map((rel) => resolve(__dirname, "..", rel));

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
  const violations = [];
  for (const filePath of GUARDED_FILES) {
    let source;
    try {
      source = readFileSync(filePath, "utf8");
    } catch (err) {
      console.error(
        `[tier-b-guard] could not read ${filePath}: ${err.message}`,
      );
      process.exit(2);
    }
    for (const spec of extractSpecifiers(source)) {
      const hit = matchForbidden(spec);
      if (hit) violations.push({ file: filePath, spec, rule: hit });
    }
  }

  if (violations.length > 0) {
    console.error(
      "[tier-b-guard] widget-runtime cluster files import forbidden inspector-app-state modules.",
    );
    console.error(
      "  Read app state through useWidgetHost() or receive it injected (see widget-host.ts / use-widget-host.ts).",
    );
    for (const v of violations) {
      const rel = v.file.includes("/client/")
        ? v.file.slice(v.file.indexOf("/client/") + "/client/".length)
        : v.file;
      console.error(
        `  - ${rel}: "${v.spec}"  (matched forbidden rule: "${v.rule}")`,
      );
    }
    process.exit(1);
  }

  console.log(
    `[tier-b-guard] OK: ${GUARDED_FILES.length} widget-runtime cluster files import no forbidden inspector-app-state modules.`,
  );
}

main();
