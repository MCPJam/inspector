#!/usr/bin/env node
/**
 * Structural guard: server code starts an assistant turn through
 * `runUnifiedAssistantTurn` (`server/utils/turn-execution.ts`), not by calling
 * an engine itself. Each direct caller re-decided retries, abort, usage and
 * tracing, so a new one fails CI when it is written, not at the next audit.
 *
 * WHAT COUNTS. A value import, by EXPORTED name (`runAssistantTurn as run`
 * counts), of an engine entry point from its module, `export { … } from`
 * included. `import type` and `type` specifiers start nothing and are allowed.
 * A namespace import of an engine module is refused, since it reaches every
 * entry point without naming one. A dynamic `import()` is not seen.
 *
 * SCOPE. Runtime code under `server/`; tests are exempt (`__tests__/`,
 * `*.test.*`, `*.spec.*`, `server/test/`). Zero files scanned is a failure, so
 * a moved directory cannot turn this into a silent pass.
 *
 * Usage: node scripts/check-turn-entry-point.mjs [--root <dir>]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  if (index !== -1 && argv[index + 1]) return resolve(argv[index + 1]);
  return resolve(__dirname, "..");
}

const root = parseRoot(process.argv.slice(2));

/** Module (extensionless, from the inspector root, or a package) → entry points. */
const ENGINE_ENTRY_POINTS = new Map([
  ["server/utils/assistant-turn", ["runAssistantTurn"]],
  [
    "server/utils/direct-chat-turn",
    ["runDirectChatTurn", "consumeDirectChatTurnHeadless"],
  ],
  [
    "server/utils/direct-chat-turn-full-stream",
    ["consumeDirectChatTurnFullStream"],
  ],
  [
    "server/utils/mcpjam-stream-handler",
    ["runChatEngineLoop", "handleMCPJamFreeChatModel"],
  ],
  [
    "server/utils/org-model-stream-handler",
    ["handleLocalOrgChatModel", "handleHostedOrgChatModel"],
  ],
  ["server/utils/harness/run-harness-turn", ["runHarnessTurn"]],
  ["ai", ["streamText"]],
]);

/** The facade and the engines behind it, which implement a turn. */
const ENGINE_LAYER = new Set([
  "server/utils/turn-execution.ts",
  "server/utils/assistant-turn.ts",
  "server/utils/direct-chat-turn.ts",
  "server/utils/direct-chat-turn-full-stream.ts",
  "server/utils/mcpjam-stream-handler.ts",
  "server/utils/org-model-stream-handler.ts",
  "server/utils/harness/run-harness-turn.ts",
]);

/**
 * Callers still allowed past the facade, each until the change it names lands.
 * An entry that no longer imports an engine is stale and fails the check, so it
 * cannot silently re-permit a bypass later.
 */
const TEMPORARY_EXCEPTIONS = new Map([
  [
    "server/routes/mcp/chat-v2.ts",
    {
      reason:
        "local chat streams UI from the direct engine (no direct `ui` sink)",
      removeWhen: "the direct runtime's `ui` sink is wired",
      owner: "@chelojimenez",
    },
  ],
  [
    "server/utils/web-chat-turn.ts",
    {
      reason: "hosted web chat calls the chat handlers with its own SSE writer",
      removeWhen: "web chat runs its turns through the facade",
      owner: "@chelojimenez",
    },
  ],
]);

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

const NAMED_IMPORT =
  /\b(?:import|export)\s+(type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const NAMESPACE_IMPORT = /\bimport\s+\*\s+as\s+\w+\s+from\s*["']([^"']+)["']/g;

/** Blank comments out, keeping offsets, so a quoted import cannot count. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:"'`\\])\/\/[^\n]*/g,
      (match, lead) => lead + " ".repeat(match.length - lead.length),
    );
}

/** The engine module a specifier names, or undefined for any other module. */
function engineModule(fromFile, specifier) {
  if (ENGINE_ENTRY_POINTS.has(specifier)) return specifier;
  if (!specifier.startsWith(".")) return undefined;
  const target = posix
    .join(posix.dirname(fromFile), specifier)
    .replace(/\.(?:[cm]?[jt]sx?)$/, "");
  return ENGINE_ENTRY_POINTS.has(target) ? target : undefined;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/** `name:line` for each engine entry point the file imports as a value. */
function engineImports(relPath, source) {
  const code = stripComments(source);
  const hits = [];
  for (const match of code.matchAll(NAMED_IMPORT)) {
    const module = engineModule(relPath, match[3]);
    if (!module || match[1]) continue;
    const entryPoints = ENGINE_ENTRY_POINTS.get(module);
    for (const raw of match[2].split(",")) {
      const specifier = raw.trim();
      if (!specifier || specifier.startsWith("type ")) continue;
      const exported = specifier.split(/\s+as\s+/)[0].trim();
      if (entryPoints.includes(exported)) {
        hits.push(`${exported}:${lineOf(code, match.index)}`);
      }
    }
  }
  for (const match of code.matchAll(NAMESPACE_IMPORT)) {
    if (engineModule(relPath, match[1])) {
      hits.push(`* as ${match[1]}:${lineOf(code, match.index)}`);
    }
  }
  return hits;
}

function isTestPath(relPath) {
  const parts = relPath.split("/");
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
    // A missing scan root yields nothing; the zero-files check reports it.
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
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
const seenExceptions = new Set();

for (const file of walk(join(root, "server"))) {
  const rel = relative(root, file).split(sep).join("/");
  if (isTestPath(rel)) continue;
  scanned += 1;
  if (ENGINE_LAYER.has(rel)) continue;
  const hits = engineImports(rel, readFileSync(file, "utf8"));
  if (hits.length === 0) continue;
  if (TEMPORARY_EXCEPTIONS.has(rel)) {
    seenExceptions.add(rel);
    continue;
  }
  for (const hit of hits) violations.push(`${rel} imports ${hit}`);
}

const stale = [...TEMPORARY_EXCEPTIONS.keys()].filter(
  (entry) => !seenExceptions.has(entry),
);
const missingEngines = [...ENGINE_LAYER].filter(
  (entry) => !existsSync(join(root, entry)),
);

if (scanned === 0) {
  console.error(
    `turn-entry-point: scanned 0 files under server/ in ${root}. The scan ` +
      "root moved; fix it rather than letting this check pass on nothing.",
  );
  process.exit(1);
}

if (violations.length || stale.length || missingEngines.length) {
  if (violations.length) {
    console.error(
      "Server code started a turn through an engine directly. Call\n" +
        "runUnifiedAssistantTurn (server/utils/turn-execution.ts) instead, and\n" +
        "extend its options if this caller needs a contract it lacks:\n",
    );
    for (const violation of violations) console.error(`  - ${violation}`);
    console.error("");
  }
  if (stale.length) {
    console.error(
      "These TEMPORARY_EXCEPTIONS no longer import an engine. Remove them;\n" +
        "a stale entry silently permits a future bypass:\n",
    );
    for (const entry of stale) console.error(`  - ${entry}`);
    console.error("");
  }
  if (missingEngines.length) {
    console.error("These ENGINE_LAYER files do not exist. Update the list:\n");
    for (const entry of missingEngines) console.error(`  - ${entry}`);
    console.error("");
  }
  process.exit(1);
}

console.log(
  `turn-entry-point: ok (${scanned} files, ${TEMPORARY_EXCEPTIONS.size} temporary exceptions)`,
);
