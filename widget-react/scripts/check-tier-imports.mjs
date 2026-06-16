// Tier B import guard for @mcpjam/widget-react.
//
// The widget runtime depends on the framework-free core (`@mcpjam/sdk`), the
// MCP Apps bridge (`@modelcontextprotocol/*`), and `@mcp-ui/client` — those are
// ALLOWED. What it must never import is inspector internals (the `@/` alias) or
// analytics/db clients, because the whole point of the package is to be
// consumable without the inspector app. This fails the build if any forbidden
// module is imported anywhere under src/ (tests included).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

const SPECIFIER_RE =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

// Bare module specifiers (matched exactly, as a `bad/...` subpath, or as a full
// path segment) that must never appear. The `@/` inspector alias is handled
// separately below.
const FORBIDDEN = ["convex", "posthog-js"];

function matchForbidden(spec) {
  // The inspector's path alias — any `@/...` import means the package reached
  // back into the app it is supposed to be independent of.
  if (spec.startsWith("@/")) return "@/ (inspector internals)";
  const segments = spec.split("/");
  for (const bad of FORBIDDEN) {
    if (spec === bad || spec.startsWith(`${bad}/`) || segments.includes(bad)) {
      return bad;
    }
  }
  return null;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(srcDir)) {
  const text = readFileSync(file, "utf8");
  let m;
  while ((m = SPECIFIER_RE.exec(text)) !== null) {
    const spec = m[1] ?? m[2];
    if (!spec) continue;
    const bad = matchForbidden(spec);
    if (bad) violations.push({ file: relative(srcDir, file), spec, bad });
  }
}

if (violations.length > 0) {
  console.error("Tier B import guard FAILED. Forbidden imports found:\n");
  for (const v of violations) {
    console.error(`  ${v.file}: "${v.spec}" (matches "${v.bad}")`);
  }
  console.error(
    "\n@mcpjam/widget-react must not import inspector internals (@/...) or " +
      "analytics/db clients. It owns the WidgetHost contract; the inspector " +
      "feeds the concrete host via the provider.",
  );
  process.exit(1);
}

console.log(
  "Tier B import guard passed: no forbidden imports under widget-react/src/.",
);
