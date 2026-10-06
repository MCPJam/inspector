#!/usr/bin/env node
/**
 * Structural guard: nothing reads `INSPECTOR_SERVICE_TOKEN` raw.
 *
 * WHY. The service credential used to be read at ~45 call sites, and each one
 * decided independently whether to trim it, what a missing value should be
 * called, and what "missing" does. Two sites sent `x-inspector-service-token:
 * ""`, turning a config gap into a backend auth failure; one swallowed the
 * throw and silently dropped the org's model policy. A self-hosted build can
 * never hold this secret, so every one of those decisions was reachable.
 *
 * `server/services/service-credential.ts` is now the only reader. This script
 * fails on a raw read anywhere else, so the next one fails CI at the moment it
 * is written rather than at the next audit.
 *
 * WHAT COUNTS AS A READ. `process.env.INSPECTOR_SERVICE_TOKEN`,
 * `env.INSPECTOR_SERVICE_TOKEN` (any `env`-named object), the bracket forms
 * `env["INSPECTOR_SERVICE_TOKEN"]`, and destructuring it out of an env object.
 * Comments are ignored; strings are not (the bracket form lives in one).
 * `MCPJAM_INSPECTOR_SERVICE_TOKEN` (the guest worker's own variable) is a
 * different name and is not matched.
 *
 * SCOPE. Runtime code under `server/`, `src/`, `shared/`, `lib/` and `bin/`.
 * Tests are exempt (`__tests__/`, `*.test.*`, `*.spec.*`, `server/test/`):
 * they `vi.stubEnv` the variable, which is a write, and the module reads it at
 * call time precisely so those stubs keep working. The scan fails if it finds
 * zero files, so a moved directory cannot turn this into a silent pass.
 *
 * Usage: node scripts/check-service-credential-reads.mjs [--root <dir>]
 * (`--root` points the scan at another inspector tree; the tests use it.)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  if (index !== -1 && argv[index + 1]) return resolve(argv[index + 1]);
  return resolve(__dirname, "..");
}

const root = parseRoot(process.argv.slice(2));

const SCAN_ROOTS = ["server", "src", "shared", "lib", "bin"];

/** The one file allowed to read the variable. */
const MODULE = join("server", "services", "service-credential.ts");

/**
 * Files still allowed a raw read while they are migrated. Must only shrink;
 * an entry that no longer reads raw is stale and fails the check, so it cannot
 * silently re-permit a read later.
 */
const ALLOWLIST = new Set([
  "server/routes/v1/agent.ts",
  "server/routes/web/hosted-elicitation.ts",
  "server/utils/org-model-config.ts",
  "server/utils/tool-approval-token.ts",
]);

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

const RAW_READ_PATTERNS = [
  /\benv\s*\??\.\s*INSPECTOR_SERVICE_TOKEN\b/g,
  /\benv\s*\??\.?\s*\[\s*["'`]INSPECTOR_SERVICE_TOKEN["'`]\s*\]/g,
  /\{[^{}]*\bINSPECTOR_SERVICE_TOKEN\b[^{}]*\}\s*=\s*(?:process\.)?env\b/g,
];

function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      // Copy strings through verbatim (the bracket form lives in one), but
      // walk them so a `//` inside a URL is not taken for a comment.
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === ch) {
          j += 1;
          break;
        }
        if (ch !== "`" && source[j] === "\n") break;
        j += 1;
      }
      out += source.slice(i, j);
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function isTestPath(relPath) {
  const parts = relPath.split(sep);
  if (parts.includes("__tests__") || parts.includes("__fixtures__"))
    return true;
  if (parts[0] === "server" && parts[1] === "test") return true;
  const base = parts[parts.length - 1];
  return base.includes(".test.") || base.includes(".spec.");
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (!EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
    if (entry.endsWith(".d.ts")) continue;
    yield full;
  }
}

let scanned = 0;
const violations = [];
const seenAllowlisted = new Set();

for (const scanRoot of SCAN_ROOTS) {
  for (const file of walk(join(root, scanRoot))) {
    const rel = relative(root, file);
    if (isTestPath(rel)) continue;
    scanned += 1;
    if (rel === MODULE) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    const hits = [];
    for (const pattern of RAW_READ_PATTERNS) {
      for (const match of code.matchAll(pattern)) {
        hits.push(lineOf(code, match.index));
      }
    }
    if (hits.length === 0) continue;
    const key = rel.split(sep).join("/");
    if (ALLOWLIST.has(key)) {
      seenAllowlisted.add(key);
      continue;
    }
    for (const line of [...new Set(hits)].sort((a, b) => a - b)) {
      violations.push(`${key}:${line}`);
    }
  }
}

const stale = [...ALLOWLIST].filter((entry) => !seenAllowlisted.has(entry));

if (scanned === 0) {
  console.error(
    "service-credential-reads: scanned 0 files under " +
      `${SCAN_ROOTS.join(", ")} in ${root}. The scan roots moved; fix ` +
      "SCAN_ROOTS rather than letting this check pass on nothing.",
  );
  process.exit(1);
}

if (violations.length || stale.length) {
  if (violations.length) {
    console.error(
      "Raw INSPECTOR_SERVICE_TOKEN reads found. Read the service credential " +
        `through ${MODULE.split(sep).join("/")} instead:\n` +
        "  getServiceCredential()        - trimmed value or null\n" +
        "  requireServiceCredential(f)   - value, or a typed hosted-only error\n" +
        "  serviceCredentialHeaders()    - outbound header, {} when unset\n",
    );
    for (const violation of violations) console.error(`  - ${violation}`);
    console.error("");
  }
  if (stale.length) {
    console.error(
      "These ALLOWLIST entries no longer read the variable raw. Remove them;\n" +
        "a stale entry silently permits a future raw read:\n",
    );
    for (const entry of stale) console.error(`  - ${entry}`);
    console.error("");
  }
  process.exit(1);
}

console.log(
  `service-credential-reads: ok (${scanned} files, ${ALLOWLIST.size} allowlisted)`,
);
