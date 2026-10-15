import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  OUTPUTS,
  ROOT,
  buildTelemetryCatalogs,
  createCatalogCache,
  loadCatalogCache,
  sourceFiles,
  writeIfChanged,
  writeTelemetryCatalogs,
} from "../generate-telemetry-catalogs.mjs";
import { watchTelemetryCatalogs } from "../telemetry-catalog-watch.mjs";

const BUDGET_MS = 1000;

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

async function until(root, file, predicate) {
  const started = performance.now();
  while (performance.now() - started < 5 * BUDGET_MS) {
    try {
      if (predicate(JSON.parse(readFileSync(join(root, file), "utf8")))) return performance.now() - started;
    } catch {
      // Not written yet: keep polling.
    }
    await new Promise((settle) => setTimeout(settle, 10));
  }
  return Infinity;
}

test("--watch lands each addition, rename and deletion within budget, once per checkout", async () => {
  const root = fixture();
  const lines = [];
  const watcher = watchTelemetryCatalogs({ root, log: (line) => lines.push(line) });
  try {
    assert.ok(watcher);
    assert.equal(watchTelemetryCatalogs({ root, log: (line) => lines.push(line) }), null);
    assert.ok(lines.some((line) => line.includes("already watching")));
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
      edit(root, file, text);
      const elapsed = await until(root, OUTPUTS.inspector, landed);
      assert.ok(elapsed <= BUDGET_MS, `${name}: ${elapsed} ms`);
    }
    rmSync(join(root, "mcpjam-inspector/server/probe.ts"));
    rmSync(join(root, "mcpjam-inspector/server/routes/gone.ts"));
    const elapsed = await until(root, OUTPUTS.inspector, (catalog) =>
      !catalog.messages.includes("watch probe renamed") && !catalog.routes.includes("/api/gone"));
    assert.ok(elapsed <= BUDGET_MS, `delete: ${elapsed} ms`);
  } finally {
    watcher?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
