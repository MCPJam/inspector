import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OUTPUTS, buildTelemetryCatalogs, loadCatalogCache } from "../generate-telemetry-catalogs.mjs";
import * as routeCatalog from "../telemetry-route-catalog.mjs";
import { loadTypeScript, mountedRoutes } from "../telemetry-route-catalog.mjs";

test("the route catalog keeps the contract its out-of-repo importer relies on", () => {
  // Backend collector builds import this file alone from a sparse checkout and
  // call `mountedRoutes(entry)`: one required argument, and nothing to resolve
  // beyond Node builtins and `typescript`.
  assert.equal(typeof routeCatalog.mountedRoutes, "function");
  assert.equal(routeCatalog.mountedRoutes.length, 1);
  const ts = loadTypeScript();
  const file = fileURLToPath(new URL("../telemetry-route-catalog.mjs", import.meta.url));
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      specifiers.push(node.moduleSpecifier.text);
    // import("x"), require("x") and createRequire(...)("x").
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        (ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "createRequire"))
    )
      specifiers.push(node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : "<computed>");
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(specifiers.includes("typescript"), "typescript is loaded through createRequire");
  assert.deepEqual(specifiers.filter((specifier) => !specifier.startsWith("node:") && specifier !== "typescript"), []);
});

test("mount graph composes literal route prefixes and methods", () => {
  const rows = mountedRoutes(fileURLToPath(new URL("../../mcpjam-inspector/server/app.ts", import.meta.url)));
  const keys = rows.map(({ method, path }) => `${method} ${path}`);
  assert.ok(keys.includes("POST /api/web/chat-v2"));
  assert.ok(keys.includes("POST /api/web/tools/execute"));
  assert.ok(keys.includes("POST /api/mcp/chat-v2"));
  assert.ok(!keys.includes("POST /chat-v2"));
  assert.ok(rows.every(({ path }) => path.startsWith("/") && !path.includes("://")));
});

test("diagnostic names include unique sorted events and literal logger messages", () => {
  const catalog = JSON.parse(buildTelemetryCatalogs({ cache: loadCatalogCache() })[OUTPUTS.inspector]);
  assert.deepEqual(catalog.events, [...new Set(catalog.events)].sort());
  assert.ok(catalog.events.every((name) => catalog.messages.includes(name)));
  assert.ok(catalog.messages.includes("[host-runtime-config] network error"));
});
