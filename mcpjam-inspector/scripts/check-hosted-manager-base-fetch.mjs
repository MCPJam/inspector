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
 * THE SECOND RULE: SDK ENTRY POINTS THAT DIAL FOR THEMSELVES. `new
 * MCPClientManager` is not the only way to open a connection. `runConformance`,
 * the conformance suites, `withEphemeralClient`, the probe and the doctor each
 * build their own client or fetch from a config, and each has a fetch seam that
 * falls back to the global one when nobody fills it. The persisted conformance
 * path went through exactly that gap after the first rule was in place: its
 * callers handed `runConformance` a bare `{ url }`, and the protocol suite
 * dropped even the fetch it was given. So a hosted file that IMPORTS one of
 * those entry points from `@mcpjam/sdk` must be on a second allowlist that
 * names the guard it dials through, and must still mention that guard. A new
 * importer fails by existing, for the same reason as above.
 *
 * SCOPE. Hosted server code only: `server/routes/web/**`,
 * `server/routes/v1/**`, `server/routes/shared/**` (the halves those two share)
 * and `server/services/**`. Not `server/index.ts` or `server/app.ts` — those are
 * the LOCAL/desktop entrypoints, where reaching `http://localhost:3000/mcp` is
 * the entire product and the guard is deliberately absent. Not `sdk/**` or
 * `cli/**`, which are not this deployment. Test files are exempt: a test
 * asserting the unguarded behavior is legitimate.
 *
 * WHAT IT DOES NOT CATCH, stated so nobody reads more into a green run: it is a
 * source scan, so it sees `new MCPClientManager` and not a manager obtained by
 * other means, and it sees a STATIC import of an entry point (a namespace
 * import of the SDK is refused outright, since it would hide one) but not a
 * dynamic `import()`. For the second rule it checks a file-level mention of the
 * guard, not each call's arguments — configs there are usually built a few
 * lines above the call. And it says nothing about whether the fetch actually
 * guards anything. Those properties are the runtime tests' job
 * (`server/utils/__tests__/hosted-mcp-base-fetch.test.ts`,
 * `server/services/__tests__/conformance-run-executor-egress.test.ts`), and
 * they assert refusals rather than non-null fields for exactly this reason.
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
  join(serverDir, "routes", "shared"),
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
 * PER CONSTRUCTION, NOT PER FILE. An earlier revision compared two counts —
 * how many managers a file builds against how many `baseFetch:` lines it has —
 * and review pointed out the obvious hole: a file with one guarded manager, one
 * unguarded manager and a stray second mention of the injection passes on
 * totals while dialling `globalThis.fetch`. A commented-out injection counted
 * too. Since this check is the thing standing in for a test that cannot exist
 * yet, being approximately right is not good enough: each constructor's own
 * argument list is now what gets inspected.
 */
const CONSTRUCTION = /new\s+MCPClientManager\s*\(/g;
const GUARD_INJECTION = /baseFetch:\s*hostedMcpBaseFetch\(\)/;

/**
 * `@mcpjam/sdk` exports that open their own connection to a caller-named
 * target, each through a fetch seam that is the global `fetch` unless filled.
 *
 * Deliberately NOT listed: `executeOAuthProxy`, `executeDebugOAuthProxy` and
 * `fetchOAuthMetadata`, which pin and re-check every hop themselves — there is
 * no seam to leave open — and anything that takes a manager the caller built,
 * which the first rule already covers.
 */
const SELF_DIALING_SDK_ENTRY_POINTS = new Set([
  "runConformance",
  "MCPConformanceTest",
  "MCPAppsConformanceTest",
  "MCPTasksConformanceTest",
  "OAuthConformanceTest",
  "withEphemeralClient",
  "probeMcpServer",
  "runServerDoctor",
  "discoverOAuthServerInfo",
  "gatherClaudeReadinessEvidence",
  "gatherOpenAIReadinessEvidence",
]);

/**
 * The hosted files allowed to import a self-dialing entry point, each with the
 * guard it dials through. The guard must still appear in the file (outside
 * comments and strings); an entry whose file no longer imports any entry point
 * is stale and fails, for the reason the manager allowlist gives.
 */
const SELF_DIALING_ALLOWED = new Map(
  [
    [
      ["services", "conformance-run-executor.ts"],
      {
        // Anchored on the assignment because the guard is DEFINED in this same
        // file: a bare name match is already satisfied by `export function
        // guardPersistedConformanceTransport(`, so deleting the call site would
        // still pass and the rule would miss the regression it exists to catch.
        guard: /=\s*guardPersistedConformanceTransport\(/,
        why: "every persisted run's transports go through guardPersistedConformanceTransport",
      },
    ],
    [
      ["routes", "shared", "conformance.ts"],
      {
        guard: /(fetchFn|baseFetch):[^,;]*createConformanceFetch\(/,
        why: "each suite is handed createConformanceFetch as fetchFn/baseFetch",
      },
    ],
    [
      ["routes", "web", "servers.ts"],
      {
        guard: /hostedMcpBaseFetch\(\)/,
        why: "the doctor's probe and connection both dial hostedMcpBaseFetch()",
      },
    ],
    [
      ["routes", "web", "oauth-connections.ts"],
      {
        guard: /HOSTED_MODE\s*\?/,
        why: "withEphemeralClient is the LOCAL branch; hosted uses createAuthorizedManager",
      },
    ],
    [
      ["services", "server-connection-worker.ts"],
      {
        guard: /createPinnedFetch\(/,
        why: "the validation probe dials a DNS-pinned fetch",
      },
    ],
    [
      ["services", "server-connection-discovery.ts"],
      {
        guard: /createPinnedFetch\(/,
        why: "the discovery probe dials a DNS-pinned fetch",
      },
    ],
    [
      ["services", "server-connection-authorize.ts"],
      {
        guard: /createPinnedFetch\(/,
        why: "OAuth discovery dials a DNS-pinned fetch",
      },
    ],
    [
      ["services", "readiness", "runner.ts"],
      {
        guard: /fetchFn:\s*options\.fetchFn/,
        why: "the gatherers REQUIRE fetchFn and the runner passes the caller's guard through",
      },
    ],
  ].map(([segments, rule]) => [resolve(join(serverDir, ...segments)), rule])
);

/**
 * Blank out comments only, keeping string literals — the module specifier of
 * an import is a string, and it is what says the binding came from the SDK.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (match, lead) =>
      lead + " ".repeat(match.length - lead.length)
    );
}

const SDK_NAMED_IMPORT =
  /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](@mcpjam\/sdk(?:\/[^"']*)?)["']/g;
const SDK_NAMESPACE_IMPORT =
  /\bimport\s+\*\s+as\s+\w+\s+from\s*["'](@mcpjam\/sdk(?:\/[^"']*)?)["']/g;

/**
 * The self-dialing entry points a file brings in from `@mcpjam/sdk`, by their
 * EXPORTED name (so `runConformance as run` still counts), ignoring `type`-only
 * specifiers, which cannot dial anything. A namespace import is reported as
 * `*`: it would make every entry point reachable without naming one.
 */
function selfDialingImports(source) {
  const code = stripComments(source);
  const found = new Set();
  for (const match of code.matchAll(SDK_NAMED_IMPORT)) {
    if (/^\s*(?:import|export)\s+type\b/.test(match[0])) continue;
    for (const raw of match[1].split(",")) {
      const specifier = raw.trim();
      if (!specifier || specifier.startsWith("type ")) continue;
      const exported = specifier.split(/\s+as\s+/)[0].trim();
      if (SELF_DIALING_SDK_ENTRY_POINTS.has(exported)) found.add(exported);
    }
  }
  for (const _ of code.matchAll(SDK_NAMESPACE_IMPORT)) found.add("*");
  return [...found].sort();
}

/**
 * Blank out comments and string literals so neither can satisfy — or trip —
 * the checks below. Replaced with equal-length runs of spaces so every
 * remaining offset still matches the original source, which is what lets the
 * error messages carry a real line number.
 */
function stripCommentsAndStrings(source) {
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
        j += 1;
      }
      out += source.slice(i, j).replace(/[^\n]/g, " ");
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * The argument list of the construction whose `new MCPClientManager(` ends at
 * `openParenIndex`, found by walking parens to the matching close. Returns
 * `null` for an unbalanced tail, which is treated as unguarded — a file this
 * scanner cannot parse is not a file it should be vouching for.
 */
function constructionArguments(source, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex, i + 1);
    }
  }
  return null;
}

/**
 * `args` with everything that is not a DIRECT property of an argument object
 * blanked out. Bracket characters survive at every depth so a kept
 * `hostedMcpBaseFetch()` still reads as a call.
 *
 * A `baseFetch` one level deeper is a PER-SERVER field: it guards that one
 * server and not the manager, so it covers neither the rest of the batch nor a
 * server attached later through `connectToServer`. The flat search this
 * replaces could not tell the two apart, so a nested decoy was enough to vouch
 * for an unguarded manager.
 */
function directProperties(args) {
  let depth = 0;
  let out = "";
  for (const ch of args) {
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      out += ch;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      out += ch;
    } else {
      out += depth === 2 ? ch : " ";
    }
  }
  return out;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
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
const selfDialingViolations = [];
const selfDialingUnguarded = [];
const seenSelfDialingAllowed = new Set();

for (const dir of GUARDED_DIRS) {
  for (const file of walk(dir)) {
    const source = readFileSync(file, "utf8");
    const code = stripCommentsAndStrings(source);

    // Rule two runs first: a file that dials through the SDK need not
    // construct a manager at all, and the rule-one `continue` below would skip
    // it.
    const entryPoints = selfDialingImports(source);
    if (entryPoints.length > 0) {
      const rel = relative(resolve(serverDir, ".."), file);
      const rule = SELF_DIALING_ALLOWED.get(resolve(file));
      if (!rule || entryPoints.includes("*")) {
        selfDialingViolations.push({ file: rel, entryPoints });
      } else {
        seenSelfDialingAllowed.add(resolve(file));
        if (!rule.guard.test(code)) {
          selfDialingUnguarded.push({ file: rel, entryPoints, rule });
        }
      }
    }

    const opens = [];
    CONSTRUCTION.lastIndex = 0;
    for (let m = CONSTRUCTION.exec(code); m; m = CONSTRUCTION.exec(code)) {
      opens.push(m.index + m[0].length - 1);
    }
    if (opens.length === 0) continue;

    const rel = relative(resolve(serverDir, ".."), file);
    const resolved = resolve(file);
    if (!ALLOWED.has(resolved)) {
      violations.push(rel);
      continue;
    }
    seenAllowed.add(resolved);

    for (const open of opens) {
      const args = constructionArguments(code, open);
      if (args === null || !GUARD_INJECTION.test(directProperties(args))) {
        unguardedAllowed.push({ file: rel, line: lineOf(code, open) });
      }
    }
  }
}

// An allowlist entry that no longer constructs a manager is stale. Left in
// place it silently re-permits a future construction in that file, which is the
// hole this check exists to close.
const stale = [...ALLOWED]
  .filter((p) => !seenAllowed.has(p))
  .map((p) => relative(resolve(serverDir, ".."), p));
const staleSelfDialing = [...SELF_DIALING_ALLOWED.keys()]
  .filter((p) => !seenSelfDialingAllowed.has(p))
  .map((p) => relative(resolve(serverDir, ".."), p));

const thisScript = relative(
  resolve(serverDir, ".."),
  fileURLToPath(import.meta.url)
);

if (
  selfDialingViolations.length ||
  selfDialingUnguarded.length ||
  staleSelfDialing.length
) {
  console.error("Hosted self-dialing SDK entry point guard failed (MJ-001).\n");
  if (selfDialingViolations.length) {
    console.error(
      "These hosted files import an `@mcpjam/sdk` entry point that opens its\n" +
        "own connection. Each one's fetch seam is `globalThis.fetch` unless it is\n" +
        "filled — loopback and private ranges reachable, redirects unvalidated.\n" +
        "Dial through a guard (`createConformanceFetch`, `hostedMcpBaseFetch()`,\n" +
        "`createPinnedFetch`) and add the file, with that guard, to\n" +
        `SELF_DIALING_ALLOWED in ${thisScript}. A namespace import (\`*\`) of the\n` +
        "SDK is refused outright: it would hide which entry points are in use.\n"
    );
    for (const { file, entryPoints } of selfDialingViolations) {
      console.error(`  - ${file} (${entryPoints.join(", ")})`);
    }
    console.error("");
  }
  if (selfDialingUnguarded.length) {
    console.error(
      "These allowlisted files no longer mention the guard they are listed with:\n"
    );
    for (const { file, entryPoints, rule } of selfDialingUnguarded) {
      console.error(
        `  - ${file} (${entryPoints.join(", ")}): expected ${rule.guard} — ${rule.why}`
      );
    }
    console.error("");
  }
  if (staleSelfDialing.length) {
    console.error(
      "These SELF_DIALING_ALLOWED entries no longer import an entry point.\n" +
        "Remove them — a stale entry silently permits a future import:\n"
    );
    for (const file of staleSelfDialing) console.error(`  - ${file}`);
    console.error("");
  }
  process.exitCode = 1;
}

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
      "These constructions dial `globalThis.fetch` — their own argument list\n" +
        "carries no `baseFetch: hostedMcpBaseFetch()`:\n"
    );
    for (const entry of unguardedAllowed) {
      console.error(`  - ${entry.file}:${entry.line}`);
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

if (process.exitCode) process.exit(process.exitCode);

console.log(
  `hosted-manager-base-fetch: ok (${seenAllowed.size} guarded factories, ` +
    `${seenSelfDialingAllowed.size} guarded SDK entry-point importers, ` +
    `${GUARDED_DIRS.map((d) => relative(resolve(serverDir, ".."), d)).join(", ")})`
);
