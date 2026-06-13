// Tier A guard: @mcpjam/chat-ui must stay provider-free and must not pull in
// any inspector wiring, MCP Apps widget runtime, sandbox/iframe, or analytics.
//
// This is the package-local equivalent of the root
// `check:mcp-v1-runtime-imports` script. It fails the build if any forbidden
// module is imported anywhere under src/ (tests included — the renderer must
// be testable without these too).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

// Each entry is matched against the *module specifier* of every import/export
// `from "..."` and dynamic `import("...")` in the source.
const FORBIDDEN = [
  "convex",
  "posthog-js",
  "@/stores",
  "@/state",
  "@/contexts",
  "@/hooks",
  "widget-replay",
  "mcp-apps",
  "csp-workbench",
  "sandboxed-iframe",
  "sandbox-proxy",
  "@modelcontextprotocol/ext-apps",
  "@mcp-ui/client",
  "@/lib/client-config",
  "@/lib/app-navigation",
  "@/lib/host-capabilities",
  "@mcpjam/design-system",
];

const SPECIFIER_RE =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

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
    const segments = spec.split("/");
    for (const bad of FORBIDDEN) {
      // Match an exact specifier, a subpath import (`bad/...`), or `bad` as a
      // full path segment (so `./widget-replay` and `../mcp-apps/x` are
      // caught) — without flagging unrelated names that merely contain the
      // substring (e.g. `my-convex-helper`).
      if (
        spec === bad ||
        spec.startsWith(`${bad}/`) ||
        segments.includes(bad)
      ) {
        violations.push({ file: relative(srcDir, file), spec, bad });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Tier A import guard FAILED. Forbidden imports found:\n");
  for (const v of violations) {
    console.error(`  ${v.file}: "${v.spec}" (matches "${v.bad}")`);
  }
  console.error(
    "\n@mcpjam/chat-ui (Tier A) must not import provider/widget/inspector modules.",
  );
  process.exit(1);
}

console.log("Tier A import guard passed: no forbidden imports under src/.");
