#!/usr/bin/env node
/**
 * Structural guard for pentest finding MJ-001.
 *
 * WHAT WENT WRONG, AND WHY A TEST WAS NOT ENOUGH. `MCPClientManager` falls back
 * to `globalThis.fetch` when neither the manager options nor the server config
 * carries a `baseFetch`, so a hosted manager built without one dials with no
 * address classification and follows redirects unchecked. Six construction
 * sites each decided that independently, and five of them decided nothing at
 * all — including the factory behind every `/api/web/*` MCP operation. The
 * runtime tests beside this script assert that today's factories carry a
 * guarded fetch; they cannot see a SEVENTH factory somebody adds next month.
 *
 * So this is the half that scales: hosted server code does not construct an
 * `MCPClientManager` at all. It calls a factory that always injects
 * `hostedMcpBaseFetch()`. A new construction site in a hosted directory fails
 * this check by existing, which is the point — the failure arrives at the
 * moment the decision is made, not the moment somebody audits it.
 *
 * SCOPE. Hosted server code only: `server/routes/web/**`,
 * `server/routes/v1/**`, `server/services/**`. Not `server/index.ts` or
 * `server/app.ts` — those are the LOCAL/desktop entrypoints, where reaching
 * `http://localhost:3000/mcp` is the entire product and the guard is
 * deliberately absent. Not `sdk/**` or `cli/**`, which are not this deployment.
 * Test files are exempt: a test asserting the unguarded behavior is legitimate.
 *
 * WHAT IT DOES NOT CATCH, stated so nobody reads more into a green run: it is a
 * source scan, so it sees `new MCPClientManager` and not a manager obtained by
 * other means, and it says nothing about whether the injected fetch actually
 * guards anything. That second property is the runtime test's job
 * (`server/utils/__tests__/hosted-mcp-base-fetch.test.ts`), and it asserts a
 * refusal rather than a non-null field for exactly this reason.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(__dirname, "..", "server");

/** Directories whose files must not construct a manager directly. */
const GUARDED_DIRS = [
  join(serverDir, "routes", "web"),
  join(serverDir, "routes", "v1"),
  join(serverDir, "services"),
];

/**
 * The chokepoint, and the only file allowed to name the SDK constructor in a
 * guarded directory.
 *
 * `routes/web/auth.ts` is on this list because `createAuthorizedManager` IS the
 * hosted factory — it builds the manager for every web MCP operation and
 * injects `hostedMcpBaseFetch()` at both of its construction sites. Moving
 * those constructions into `utils/` would buy nothing: the file would still be
 * the one place that decides, and the batch authorization it is interleaved
 * with belongs here.
 */
const ALLOWED = new Set(
  [
    join(serverDir, "routes", "web", "auth.ts"),
    join(serverDir, "routes", "web", "mcpjam-agent.ts"),
    join(serverDir, "routes", "v1", "agent.ts"),
    join(serverDir, "services", "evals", "route-helpers.ts"),
  ].map((p) => resolve(p))
);

/**
 * Every allowed file must pass the guard AT EVERY CONSTRUCTION, or the
 * allowlist is a hole.
 *
 * Counted rather than merely present: `auth.ts` and `mcpjam-agent.ts` each
 * build two managers, and "the file mentions `hostedMcpBaseFetch` somewhere"
 * would have been satisfied by guarding one of them — which is close to the
 * shape of the original bug, where the conformance lane was guarded and the
 * lane beside it was not.
 */
const CONSTRUCTION = /new\s+MCPClientManager\s*\(/g;
const GUARD_INJECTION = /baseFetch:\s*hostedMcpBaseFetch\(\)/g;

function count(source, pattern) {
  return (source.match(pattern) ?? []).length;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      yield* walk(full);
      continue;
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    if (entry.includes(".test.") || entry.includes(".spec.")) continue;
    yield full;
  }
}

const violations = [];
const unguardedAllowed = [];
const seenAllowed = new Set();

for (const dir of GUARDED_DIRS) {
  for (const file of walk(dir)) {
    const source = readFileSync(file, "utf8");
    const constructions = count(source, CONSTRUCTION);
    if (constructions === 0) continue;
    const resolved = resolve(file);
    if (!ALLOWED.has(resolved)) {
      violations.push(relative(resolve(serverDir, ".."), file));
      continue;
    }
    seenAllowed.add(resolved);
    const injections = count(source, GUARD_INJECTION);
    if (injections < constructions) {
      unguardedAllowed.push({
        file: relative(resolve(serverDir, ".."), file),
        constructions,
        injections,
      });
    }
  }
}

// An allowlist entry that no longer constructs a manager is stale. Left in
// place it silently re-permits a future construction in that file, which is the
// hole this check exists to close.
const stale = [...ALLOWED]
  .filter((p) => !seenAllowed.has(p))
  .map((p) => relative(resolve(serverDir, ".."), p));

if (violations.length || unguardedAllowed.length || stale.length) {
  console.error("Hosted MCPClientManager guard failed (MJ-001).\n");
  if (violations.length) {
    console.error(
      "These hosted files construct `new MCPClientManager` directly. A hosted\n" +
        "manager without a `baseFetch` dials `globalThis.fetch`: loopback and\n" +
        "private ranges reachable, redirects unvalidated. Pass\n" +
        "`baseFetch: hostedMcpBaseFetch()` and add the file to ALLOWED in\n" +
        `${relative(resolve(serverDir, ".."), fileURLToPath(import.meta.url))}:\n`
    );
    for (const file of violations) console.error(`  - ${file}`);
    console.error("");
  }
  if (unguardedAllowed.length) {
    console.error(
      "These allowlisted factories construct more managers than they guard, so\n" +
        "at least one construction dials `globalThis.fetch`. Every one needs\n" +
        "`baseFetch: hostedMcpBaseFetch()`:\n"
    );
    for (const entry of unguardedAllowed) {
      console.error(
        `  - ${entry.file} (${entry.constructions} constructed, ${entry.injections} guarded)`
      );
    }
    console.error("");
  }
  if (stale.length) {
    console.error(
      "These allowlist entries no longer construct a manager. Remove them —\n" +
        "a stale entry silently permits a future construction in that file:\n"
    );
    for (const file of stale) console.error(`  - ${file}`);
    console.error("");
  }
  process.exit(1);
}

console.log(
  `hosted-manager-base-fetch: ok (${seenAllowed.size} guarded factories, ` +
    `${GUARDED_DIRS.map((d) => relative(resolve(serverDir, ".."), d)).join(", ")})`
);
