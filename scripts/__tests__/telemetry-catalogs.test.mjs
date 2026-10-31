import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  OUTPUTS,
  ROOT,
  buildTelemetryCatalogs,
  checkoutCacheFile,
  createCatalogCache,
  loadCatalogCache,
  sourceFiles,
  writeIfChanged,
  writeTelemetryCatalogs,
} from "../generate-telemetry-catalogs.mjs";
import { watchTelemetryCatalogs } from "../telemetry-catalog-watch.mjs";

// Lint CI runs this on shared runners, and a loaded machine took up to 1.2 s to
// land a save. The budget bounds what a user would notice; the re-parse count in
// the watch test is the load-independent guard against a scan doing extra work.
const BUDGET_MS = 5000;

/** A minimal checkout: one SDK error, one diagnostic code, one log event, one mounted route. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "telemetry-catalogs-"));
  const files = {
    "sdk/tsup.config.ts": 'export default { entry: ["src/index.ts"] };',
    "sdk/src/index.ts": "export class SdkProbeError extends Error {}",
    "sdk/src/error-describer/catalog.ts": 'export const ERROR_CATALOG = { "probe-slug": {} };',
    "mcpjam-inspector/shared/codes.ts": 'export const V1_ERROR_CODES = ["PROBE_CODE"] as const;',
    "mcpjam-inspector/shared/log-events.ts": 'export type RequestEventMap = { "probe.request": { statusCode: number } };',
    "mcpjam-inspector/server/app.ts": [
      'import { items } from "./routes/items";',
      'import { gone } from "./routes/gone";',
      'app.route("/api", items);',
      'app.route("/api/gone", gone);',
    ].join("\n"),
    "mcpjam-inspector/server/routes/items.ts": 'items.get("/before", handler);',
    "mcpjam-inspector/server/routes/gone.ts": 'gone.post("/", handler);',
    "mcpjam-inspector/client/src/lib/app-routes.ts": 'export const ROUTES = [{ path: "home", scope: "global" }];',
    "mcpjam-inspector/node_modules/dep/index.ts": 'logger.warn("dependency message");',
    "mcpjam-inspector/server/__tests__/probe.test.ts": 'logger.warn("test message");',
  };
  for (const [file, text] of Object.entries(files)) edit(root, file, text);
  return root;
}

/** Write and move the mtime forward, so a same-size edit inside one clock tick still registers. */
function edit(root, file, text) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  const previous = existsSync(path) ? statSync(path).mtimeMs : Date.now();
  writeFileSync(path, text);
  const later = new Date(Math.max(Date.now(), previous + 1000));
  utimesSync(path, later, later);
}

const inspector = (outputs) => JSON.parse(outputs[OUTPUTS.inspector]);
const routeKeys = (outputs) => inspector(outputs).routeEntries.map(({ method, path }) => `${method} ${path}`);

test("the walk finds exactly the source files git tracks or would add", { skip: !existsSync(join(ROOT, ".git")) }, () => {
  const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "sdk/src", "mcpjam-inspector"],
    { cwd: ROOT, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(
      (file) =>
        /\.[cm]?tsx?$/.test(file) &&
        existsSync(join(ROOT, file)) &&
        !/(?:__tests__|\.test\.|\.generated\.|\/tests\/|\.bundled\.)/.test(file),
    );
  assert.deepEqual(sourceFiles(ROOT, true), listed);
});

test("the SDK catalog is the same with and without the Inspector server and client", () => {
  const cache = loadCatalogCache();
  const full = buildTelemetryCatalogs({ cache, full: true });
  const sdkOnly = buildTelemetryCatalogs({ cache, full: false });
  assert.deepEqual(Object.keys(sdkOnly), [OUTPUTS.sdk]);
  assert.equal(sdkOnly[OUTPUTS.sdk], full[OUTPUTS.sdk]);
  for (const text of Object.values(full)) {
    const catalog = JSON.parse(text);
    for (const file of Array.isArray(catalog) ? catalog : catalog.files)
      assert.ok(!file.includes("\\") && !file.startsWith("/"), `not a relative POSIX path: ${file}`);
  }
});

test("an unchanged write leaves the file and its mtime alone", () => {
  const root = fixture();
  try {
    assert.deepEqual(writeTelemetryCatalogs({ root }).sort(), Object.values(OUTPUTS).sort());
    const before = Object.values(OUTPUTS).map((file) => statSync(join(root, file)).mtimeMs);
    assert.deepEqual(writeTelemetryCatalogs({ root }), []);
    assert.deepEqual(Object.values(OUTPUTS).map((file) => statSync(join(root, file)).mtimeMs), before);
    const file = join(root, "probe.json");
    assert.equal(writeIfChanged(file, "a"), true);
    assert.equal(writeIfChanged(file, "a"), false);
    assert.equal(writeIfChanged(file, "b"), true);
    assert.equal(readFileSync(file, "utf8"), "b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without the Inspector server only the SDK catalog is written", () => {
  const root = fixture();
  try {
    rmSync(join(root, "mcpjam-inspector/server"), { recursive: true });
    assert.deepEqual(writeTelemetryCatalogs({ root }), [OUTPUTS.sdk]);
    const sdk = JSON.parse(readFileSync(join(root, OUTPUTS.sdk), "utf8"));
    assert.deepEqual(sdk.diagnosticFields.code, ["PROBE_CODE"]);
    assert.deepEqual(sdk.errors, ["SdkProbeError"]);
    assert.deepEqual(sdk.slugs, ["probe-slug"]);
    assert.ok(sdk.files.includes("dist/index.js"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Inspector catalog names dependency errors and keeps the capturing event as a fact", () => {
  const root = fixture();
  try {
    const outputs = buildTelemetryCatalogs({ root });
    assert.ok(inspector(outputs).errors.includes("McpError"));
    assert.ok(JSON.parse(outputs[OUTPUTS.browser]).errors.includes("AI_APICallError"));
    assert.deepEqual(inspector(outputs).diagnosticFields.event, ["probe.request"]);
    assert.ok(!JSON.parse(outputs[OUTPUTS.sdk]).errors.includes("McpError"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second scan in one process sees edited, renamed and deleted routes", () => {
  const root = fixture();
  try {
    const cache = createCatalogCache();
    const first = buildTelemetryCatalogs({ root, cache });
    assert.ok(routeKeys(first).includes("GET /api/before"));
    assert.ok(routeKeys(first).includes("POST /api/gone"));
    assert.ok(!inspector(first).messages.includes("dependency message"));
    assert.ok(!inspector(first).messages.includes("test message"));
    edit(root, "mcpjam-inspector/server/routes/items.ts", 'items.get("/after", handler);');
    rmSync(join(root, "mcpjam-inspector/server/routes/gone.ts"));
    for (const next of [buildTelemetryCatalogs({ root, cache }), buildTelemetryCatalogs({ root })]) {
      assert.ok(routeKeys(next).includes("GET /api/after"));
      assert.ok(!routeKeys(next).includes("GET /api/before"));
      assert.ok(!routeKeys(next).some((key) => key.includes("/gone")));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a LogConvexId field gets the context-only convexId rule, a plain string none", () => {
  const root = fixture();
  try {
    edit(root, "mcpjam-inspector/shared/log-events.ts", [
      "interface CommonLogContext { orgId?: LogConvexId | null; sessionId?: string | null }",
      'export type RequestEventMap = { "probe.request": { statusCode: number; orgId: string } };',
    ].join("\n"));
    assert.deepEqual(inspector(buildTelemetryCatalogs({ root })).fields, {
      orgId: { kind: "convexId" },
      statusCode: { kind: "number" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a payload declared in log-events/ gets field rules; one elsewhere does not", () => {
  const root = fixture();
  try {
    edit(root, "mcpjam-inspector/shared/log-events/probe.ts", "export type ProbeEvent = { drained: boolean; waitedMs: number };");
    edit(root, "mcpjam-inspector/shared/probe-event.ts", "export type Elsewhere = { elsewhereMs: number };");
    edit(root, "mcpjam-inspector/shared/log-events.ts",
      'export type SystemEventMap = { "probe.system": import("./log-events/probe.js").ProbeEvent };');
    const catalog = inspector(buildTelemetryCatalogs({ root }));
    assert.deepEqual(catalog.fields, { drained: { kind: "boolean" }, waitedMs: { kind: "number" } });
    assert.deepEqual(catalog.events, ["probe.system"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Milliseconds until `condition` holds, or Infinity past the budget. */
async function within(condition) {
  const started = performance.now();
  while (performance.now() - started < BUDGET_MS) {
    try {
      if (condition()) return performance.now() - started;
    } catch {
      // Not written yet: keep polling.
    }
    await new Promise((settle) => setTimeout(settle, 10));
  }
  return Infinity;
}

const readCatalog = (root, file) => JSON.parse(readFileSync(join(root, file), "utf8"));
const until = (root, file, predicate) => within(() => predicate(readCatalog(root, file)));
const quiet = () => {};

test("--watch lands each addition, rename and deletion within budget, once per checkout", async () => {
  const root = fixture();
  const lines = [];
  const cache = createCatalogCache();
  const watcher = watchTelemetryCatalogs({ root, cache, log: (line) => lines.push(line) });
  const standby = watchTelemetryCatalogs({ root, log: (line) => lines.push(line) });
  try {
    assert.equal(watcher.watching, true);
    assert.equal(standby.watching, false);
    assert.ok(lines.some((line) => line.includes("standing by")));
    const steps = [
      ["add a log message", "mcpjam-inspector/server/probe.ts", 'logger.warn("watch probe added");',
        (catalog) => catalog.messages.includes("watch probe added")],
      ["rename the log message", "mcpjam-inspector/server/probe.ts", 'logger.warn("watch probe renamed");',
        (catalog) => catalog.messages.includes("watch probe renamed") && !catalog.messages.includes("watch probe added")],
      ["add a route", "mcpjam-inspector/server/routes/items.ts", 'items.get("/before", handler); items.get("/added", handler);',
        (catalog) => catalog.routes.includes("/api/added")],
      ["rename the route", "mcpjam-inspector/server/routes/items.ts", 'items.get("/before", handler); items.get("/renamed", handler);',
        (catalog) => catalog.routes.includes("/api/renamed") && !catalog.routes.includes("/api/added")],
    ];
    for (const [name, file, text, landed] of steps) {
      const parsed = cache.parsed;
      edit(root, file, text);
      const elapsed = await until(root, OUTPUTS.inspector, landed);
      assert.ok(elapsed <= BUDGET_MS, `${name}: ${elapsed} ms`);
      // Load can delay a save, never multiply its work: only the edited file is parsed again.
      assert.ok(cache.parsed - parsed <= 2, `${name}: re-parsed ${cache.parsed - parsed} files`);
    }
    rmSync(join(root, "mcpjam-inspector/server/probe.ts"));
    rmSync(join(root, "mcpjam-inspector/server/routes/gone.ts"));
    const elapsed = await until(root, OUTPUTS.inspector, (catalog) =>
      !catalog.messages.includes("watch probe renamed") && !catalog.routes.includes("/api/gone"));
    assert.ok(elapsed <= BUDGET_MS, `delete: ${elapsed} ms`);
  } finally {
    standby.stop();
    watcher.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a standby watcher takes over a released or stale lock, and a replaced writer stops writing", async () => {
  const root = fixture();
  const lock = checkoutCacheFile(root, "watch", "lock");
  const first = watchTelemetryCatalogs({ root, log: quiet, takeoverMs: 20 });
  const second = watchTelemetryCatalogs({ root, log: quiet, takeoverMs: 20 });
  const messages = () => readCatalog(root, OUTPUTS.inspector).messages;
  const save = (message) => edit(root, "mcpjam-inspector/server/probe.ts", `logger.warn(${JSON.stringify(message)});`);
  try {
    assert.equal(first.watching, true);
    assert.equal(second.watching, false);

    // The writer's dev process closed: the standby takes the released lock.
    first.stop();
    assert.ok((await within(() => second.watching)) <= BUDGET_MS, "standby took over a released lock");
    save("after takeover");
    assert.ok((await until(root, OUTPUTS.inspector, (catalog) => catalog.messages.includes("after takeover"))) <= BUDGET_MS);

    // Another watcher judged this one stale and replaced the lock: the next scan
    // stands down without writing, so there is never a second writer.
    writeFileSync(lock, `${process.pid} another-watcher`);
    save("while replaced");
    assert.ok((await within(() => !second.watching)) <= BUDGET_MS, "replaced writer stood by");
    assert.ok(!messages().includes("while replaced"));

    // That watcher stopped refreshing the lock (a reused PID, say): it is stale.
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    assert.ok((await within(() => second.watching && messages().includes("while replaced"))) <= BUDGET_MS, "took over a stale lock");

    // A lock whose owner died is free at once, however fresh.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(lock, `${dead} dead-watcher`);
    save("after a dead owner");
    assert.ok((await until(root, OUTPUTS.inspector, (catalog) => catalog.messages.includes("after a dead owner"))) <= BUDGET_MS);
    assert.equal(second.watching, true);
    assert.equal(readFileSync(lock, "utf8").split(" ")[0], String(process.pid));
  } finally {
    first.stop();
    second.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkouts sharing one node_modules keep separate watcher locks and parse caches", async () => {
  const a = fixture();
  const b = fixture();
  try {
    // A worktree that symlinks another checkout's node_modules.
    mkdirSync(join(a, "node_modules"));
    symlinkSync(join(a, "node_modules"), join(b, "node_modules"), "junction");
    const [lockA, lockB] = [a, b].map((root) => checkoutCacheFile(root, "watch", "lock"));
    assert.notEqual(lockA, lockB);

    const watchA = watchTelemetryCatalogs({ root: a, log: quiet });
    const watchB = watchTelemetryCatalogs({ root: b, log: quiet });
    try {
      assert.equal(watchA.watching, true);
      assert.equal(watchB.watching, true);
      assert.equal(realpathSync(dirname(lockA)), realpathSync(dirname(lockB)));
      edit(b, "mcpjam-inspector/server/probe.ts", 'logger.warn("only in b");');
      assert.ok((await until(b, OUTPUTS.inspector, (catalog) => catalog.messages.includes("only in b"))) <= BUDGET_MS);
      assert.ok(!readCatalog(a, OUTPUTS.inspector).messages.includes("only in b"));
    } finally {
      watchA.stop();
      watchB.stop();
    }

    // Alternating runs each start warm: neither prunes or overwrites the other's facts.
    for (const root of [a, b, a, b]) {
      const cache = loadCatalogCache(root);
      writeTelemetryCatalogs({ root, cache });
      assert.equal(cache.parsed, 0, `${root === a ? "a" : "b"} re-parsed after the other checkout ran`);
    }
    // One in-memory cache across roots: a run prunes only its own root's entries.
    const shared = createCatalogCache();
    writeTelemetryCatalogs({ root: a, cache: shared });
    writeTelemetryCatalogs({ root: b, cache: shared });
    const parsed = shared.parsed;
    writeTelemetryCatalogs({ root: a, cache: shared });
    assert.equal(shared.parsed, parsed);
  } finally {
    for (const root of [a, b]) rmSync(root, { recursive: true, force: true });
  }
});

test("the generator runs when started through a symlinked path", () => {
  const root = fixture();
  const link = `${root}-link`;
  try {
    mkdirSync(join(root, "scripts"));
    for (const file of ["generate-telemetry-catalogs.mjs", "telemetry-route-catalog.mjs"])
      copyFileSync(join(ROOT, "scripts", file), join(root, "scripts", file));
    mkdirSync(join(root, "node_modules"));
    symlinkSync(join(ROOT, "node_modules", "typescript"), join(root, "node_modules", "typescript"), "junction");
    symlinkSync(root, link, "junction");
    const output = execFileSync(process.execPath, [join(link, "scripts", "generate-telemetry-catalogs.mjs")], { encoding: "utf8" });
    assert.match(output, /^\[telemetry\] wrote /);
    assert.ok(readCatalog(root, OUTPUTS.inspector).routes.includes("/api/before"));
  } finally {
    rmSync(link, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
