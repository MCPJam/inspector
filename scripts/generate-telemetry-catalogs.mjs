#!/usr/bin/env node
/**
 * Telemetry catalogs: the code-owned names (files, routes, error classes, log
 * messages, codes) the strict telemetry builders may forward. Everything here
 * comes from first-party source; runtime text never adds a name.
 *
 * They are build outputs, not committed files. Every entry point that reads
 * them (SDK build/test/typecheck, Inspector dev, build, test and typecheck,
 * Electron, Docker, `npm install`) runs this first, and dev loops run
 * `--watch`, so nobody runs it by hand.
 *
 *   node scripts/generate-telemetry-catalogs.mjs           write what changed
 *   node scripts/generate-telemetry-catalogs.mjs --watch   keep them current
 *
 * Without the Inspector server and client (the Docker SDK step), only the SDK
 * catalog is written; it is identical in both modes. Files are rewritten only
 * when their content changes, so an unchanged run never bumps an mtime that
 * `build-sdk-if-stale.mjs` would read as an SDK rebuild.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { debuglog } from "node:util";
import { createRequire } from "node:module";
import { createSourceCache, loadTypeScript, mountedRoutes } from "./telemetry-route-catalog.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// NODE_DEBUG=telemetry shows why the parse cache was skipped.
const debug = debuglog("telemetry");
export const OUTPUTS = {
  sdk: "sdk/src/internal/telemetry-catalog.generated.json",
  inspector: "mcpjam-inspector/shared/telemetry-catalog.generated.json",
  browser: "mcpjam-inspector/shared/browser-telemetry-catalog.generated.json",
  browserFiles: "mcpjam-inspector/shared/browser-telemetry-source-files.generated.json",
};
// Build output, caches and checkouts: never first-party source.
export const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", ".vite", "coverage", "worktrees",
  ".claude", ".git", "test-results", "playwright-report", ".playwright",
  ".local", ".harness-bridge", ".npm-cache",
]);
const CODE_LISTS = [
  "V1_ERROR_CODES", "AI_EXECUTION_REFUSAL_CODES", "AI_REUSED_REFUSAL_CODES",
  "PLATFORM_V1_ERROR_CODES", "ROUTINE_CODES", "ORG_POLICY_ROUTINE_CODES",
];
const LOG_METHODS = ["error", "warn", "info", "debug"];
export const SOURCE = /\.[cm]?tsx?$/;
const EXCLUDED = /(?:__tests__|\.test\.|\.generated\.|\/tests\/|\.bundled\.)/;
const posix = (path) => path.split(sep).join("/");
export const cacheDir = (root = ROOT) => join(root, "node_modules", ".cache", "mcpjam-telemetry");

/** Every source file under `dir`, as sorted root-relative POSIX paths. */
function walk(root, dir, files = []) {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      // A nested checkout (worktree, submodule) is someone else's source.
      if (!SKIP_DIRS.has(entry.name) && !existsSync(join(root, path, ".git"))) walk(root, path, files);
    } else if (entry.isFile() && SOURCE.test(entry.name) && !EXCLUDED.test(path)) files.push(path);
  }
  return files;
}

export function sourceFiles(root = ROOT, full = isFullCheckout(root)) {
  const dirs = ["sdk/src", ...(full ? ["mcpjam-inspector"] : ["mcpjam-inspector/shared"])];
  // Code-point order, as git sorts, keeps merged field values in a stable order.
  return dirs.flatMap((dir) => walk(root, dir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export const isFullCheckout = (root = ROOT) =>
  existsSync(join(root, "mcpjam-inspector/server/app.ts")) &&
  existsSync(join(root, "mcpjam-inspector/client/src/lib/app-routes.ts"));

/** Catalog facts of one parsed file; persisted, so keep them small and JSON. */
function catalogFacts(source, file) {
  const ts = loadTypeScript();
  const literal = (node) =>
    ts.isLiteralTypeNode(node) && (ts.isStringLiteral(node.literal) || ts.isNumericLiteral(node.literal))
      ? node.literal.text
      : undefined;
  const path = posix(file);
  const facts = { errors: [], messages: [], codes: [] };
  const appRoutes = path.endsWith("/client/src/lib/app-routes.ts");
  const logEvents = path.endsWith("/log-events.ts");
  const errorCatalog = path.endsWith("/sdk/src/error-describer/catalog.ts");
  const sdkBuild = path.endsWith("/sdk/tsup.config.ts");
  if (appRoutes) facts.appRoutes = [];
  if (logEvents) Object.assign(facts, { events: [], fields: [] });
  if (errorCatalog) facts.slugs = [];
  if (sdkBuild) facts.entries = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && CODE_LISTS.includes(node.name.getText(source)) && node.initializer) {
      const collect = (child) => {
        if (ts.isStringLiteral(child)) facts.codes.push(child.text);
        else ts.forEachChild(child, collect);
      };
      collect(node.initializer);
    }
    if (errorCatalog && ts.isVariableDeclaration(node) && node.name.getText(source) === "ERROR_CATALOG" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties)
        if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name)) facts.slugs.push(property.name.text);
    }
    if (sdkBuild && ts.isPropertyAssignment(node) && node.name.getText(source) === "entry" && ts.isArrayLiteralExpression(node.initializer)) {
      for (const entry of node.initializer.elements)
        if (ts.isStringLiteral(entry) && /^src\/.+\.ts$/.test(entry.text))
          facts.entries.push(entry.text.replace(/^src\//, "dist/").replace(/\.ts$/, ".js"));
    }
    if (
      ts.isClassDeclaration(node) &&
      node.name &&
      node.heritageClauses?.some((clause) => clause.types.some((type) => /Error$/.test(type.expression.getText(source))))
    )
      facts.errors.push(node.name.text);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = node.expression.expression.getText(source);
      const method = node.expression.name.text;
      const message = node.arguments[0];
      if ((method === "captureMessage" || (owner === "logger" && LOG_METHODS.includes(method))) && message && ts.isStringLiteral(message))
        facts.messages.push(message.text);
    }
    if (appRoutes && ts.isObjectLiteralExpression(node)) {
      const values = Object.fromEntries(node.properties.flatMap((property) =>
        ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)
          ? [[property.name.getText(source), property.initializer.text]] : []));
      if (typeof values.path === "string" && values.scope)
        facts.appRoutes.push(`${values.scope === "project" ? "/p/:projectId" : ""}/${values.path}`);
    }
    if (logEvents && ts.isTypeAliasDeclaration(node) && ["RequestEventMap", "SystemEventMap"].includes(node.name.text)) {
      for (const member of ts.isTypeLiteralNode(node.type) ? node.type.members : [])
        if (member.name && (ts.isStringLiteral(member.name) || ts.isIdentifier(member.name))) facts.events.push(member.name.text);
    }
    if (logEvents && ts.isPropertySignature(node) && node.type && node.name) {
      const key = node.name.getText(source).replaceAll('"', "");
      const types = ts.isUnionTypeNode(node.type) ? node.type.types : [node.type];
      const values = types.map(literal).filter((value) => value !== undefined);
      if (values.length) facts.fields.push([key, { values }]);
      else if (types.some((type) => type.kind === ts.SyntaxKind.BooleanKeyword)) facts.fields.push([key, { kind: "boolean" }]);
      else if (types.some((type) => type.kind === ts.SyntaxKind.NumberKeyword)) facts.fields.push([key, { kind: "number" }]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return facts;
}

/** One cache per process (or watcher), validated per file by mtime and size. */
export function createCatalogCache(entries = new Map()) {
  return createSourceCache({ extract: catalogFacts, entries });
}

const sortUnique = (values) => [...new Set(values)].sort();

/**
 * Catalog text by output path. `full` defaults to whether this checkout has
 * the Inspector server and client; without them only the SDK catalog is built.
 */
export function buildTelemetryCatalogs({ root = ROOT, cache = createCatalogCache(), full = isFullCheckout(root) } = {}) {
  const facts = (path) => cache.facts(join(root, path));
  const catalogs = {
    sdk: { files: [], routes: [], errors: [], messages: [] },
    inspector: { files: [], routes: [], errors: [], messages: [] },
  };
  const fields = {};
  const events = [];
  const browserRoutes = [];
  const browserMessages = [];
  const slugs = [];
  const codes = [];
  for (const file of sourceFiles(root, full)) {
    const sdk = file.startsWith("sdk/");
    const catalog = catalogs[sdk ? "sdk" : "inspector"];
    const found = facts(file);
    catalog.errors.push(...found.errors);
    catalog.messages.push(...found.messages);
    if (file.includes("/client/") || file.includes("/shared/")) browserMessages.push(...found.messages);
    // Diagnostic codes are shared by both catalogs, so only SDK and shared code declares them.
    if (sdk || file.startsWith("mcpjam-inspector/shared/")) codes.push(...found.codes);
    if (file === "sdk/src/error-describer/catalog.ts") slugs.push(...found.slugs);
    if (found.appRoutes) browserRoutes.push(...found.appRoutes);
    if (found.events) events.push(...found.events);
    for (const [key, rule] of found.fields ?? [])
      fields[key] = rule.values ? { values: [...new Set([...(fields[key]?.values ?? []), ...rule.values])] } : rule;
    catalog.files.push(file.replace(/^(?:sdk|mcpjam-inspector)\//, ""));
  }
  catalogs.sdk.files.push(...facts("sdk/tsup.config.ts").entries);
  const diagnosticFields = { code: sortUnique(codes), scope: ["user", "organization", "platform"] };
  const outputs = { [OUTPUTS.sdk]: { ...catalogs.sdk, slugs, diagnosticFields } };
  if (full) {
    catalogs.inspector.routeEntries = mountedRoutes(join(root, "mcpjam-inspector/server/app.ts"), cache);
    catalogs.inspector.routes = catalogs.inspector.routeEntries.map((entry) => entry.path);
    catalogs.inspector.files.push("dist/server/index.js", ".vite/build/main.cjs");
    outputs[OUTPUTS.inspector] = {
      ...catalogs.inspector,
      messages: [...catalogs.inspector.messages, ...events],
      slugs,
      diagnosticFields,
      events: sortUnique(events),
      fields,
    };
    outputs[OUTPUTS.browser] = {
      files: [], errors: catalogs.inspector.errors, messages: browserMessages, routes: browserRoutes, slugs, diagnosticFields,
    };
    outputs[OUTPUTS.browserFiles] = catalogs.inspector.files.filter((file) => /^(client|shared)\//.test(file)).sort();
  }
  return Object.fromEntries(Object.entries(outputs).map(([file, catalog]) => {
    if (!Array.isArray(catalog)) for (const key of ["files", "routes", "errors", "messages"]) catalog[key] = sortUnique(catalog[key]);
    // Compact catalogs avoid thousands of mechanically repeated lines.
    return [file, `${JSON.stringify(catalog)}\n`];
  }));
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Same bytes: no write. Otherwise a temp file and an atomic rename, so concurrent runs never interleave. */
export function writeIfChanged(file, text) {
  try {
    if (readFileSync(file, "utf8") === text) return false;
  } catch {
    // Missing or unreadable: write it.
  }
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(temp, text);
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temp, file);
      return true;
    } catch (error) {
      // Windows refuses to replace a file another process (an editor, a watcher) has open.
      if (attempt >= 10 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) {
        rmSync(temp, { force: true });
        throw error;
      }
      pause(25 * attempt);
    }
  }
}

// Parse facts persist across processes, so hook runs re-parse only what changed.
const CACHE_VERSION = createHash("sha256")
  .update(createRequire(import.meta.url)("typescript/package.json").version)
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(readFileSync(fileURLToPath(new URL("./telemetry-route-catalog.mjs", import.meta.url))))
  .digest("hex");

export function loadCatalogCache(root = ROOT) {
  try {
    const saved = JSON.parse(readFileSync(join(cacheDir(root), "facts.json"), "utf8"));
    if (saved.version === CACHE_VERSION) return createCatalogCache(new Map(saved.entries));
  } catch (error) {
    // No cache yet, or a torn one: parse every file.
    debug("parse cache not loaded: %s", error.message);
  }
  return createCatalogCache();
}

function saveCache(root, cache, changed) {
  if (!changed || !existsSync(join(root, "node_modules"))) return;
  try {
    writeIfChanged(join(cacheDir(root), "facts.json"), JSON.stringify({ version: CACHE_VERSION, entries: [...cache.entries] }));
  } catch (error) {
    // A cache that cannot be written only costs the next run a re-parse.
    debug("parse cache not saved: %s", error.message);
  }
}

/** Build and write the catalogs whose content changed; returns the paths written. */
export function writeTelemetryCatalogs({ root = ROOT, cache, full } = {}) {
  cache ??= loadCatalogCache(root);
  const { parsed } = cache;
  cache.used.clear();
  const outputs = buildTelemetryCatalogs({ root, cache, full });
  // Forget deleted and renamed files, so a long-lived watcher cache never grows.
  let pruned = 0;
  for (const file of cache.entries.keys()) if (!cache.used.has(file) && cache.entries.delete(file)) pruned++;
  const written = Object.entries(outputs).filter(([file, text]) => writeIfChanged(join(root, file), text)).map(([file]) => file);
  saveCache(root, cache, cache.parsed !== parsed || pruned > 0);
  return written;
}

/** Vitest globalSetup: fresh catalogs before the run, and again before every watch rerun. */
export function setup(project) {
  const cache = loadCatalogCache(ROOT);
  writeTelemetryCatalogs({ cache });
  project?.onTestsRerun?.(() => {
    writeTelemetryCatalogs({ cache });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Not awaited: the watcher imports this module, which must finish evaluating first.
  if (process.argv.includes("--watch")) import("./telemetry-catalog-watch.mjs").then((watcher) => watcher.watchTelemetryCatalogs());
  else {
    const started = performance.now();
    const written = writeTelemetryCatalogs();
    if (written.length) console.log(`[telemetry] wrote ${written.join(", ")} in ${Math.round(performance.now() - started)} ms`);
  }
}
