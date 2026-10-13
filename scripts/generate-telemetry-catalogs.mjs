import { mountedRoutes } from "./telemetry-route-catalog.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

// Only tracked first-party source participates; runtime text never adds a name.
const files = execFileSync("git", ["ls-files", "sdk/src", "mcpjam-inspector"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(
    (file) =>
      /\.[cm]?tsx?$/.test(file) &&
      !/(?:__tests__|\.test\.|\.generated\.|\/tests\/)/.test(file),
  );
const catalogs = {
  sdk: { frames: {}, routes: [], errors: [], messages: [] },
  inspector: { frames: {}, routes: [], errors: [], messages: [] },
};
const fields = {};
const events = [];
const literal = (node) =>
  ts.isLiteralTypeNode(node) &&
  (ts.isStringLiteral(node.literal) || ts.isNumericLiteral(node.literal))
    ? node.literal.text
    : undefined;
for (const file of files) {
  const group = file.startsWith("sdk/") ? "sdk" : "inspector";
  const catalog = catalogs[group];
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set();
  const visit = (node) => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isFunctionExpression(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      names.add(node.name.text);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    )
      names.add(node.name.text);
    if (
      ts.isClassDeclaration(node) &&
      node.name &&
      node.heritageClauses?.some((clause) =>
        clause.types.some((type) =>
          /Error$/.test(type.expression.getText(source)),
        ),
      )
    )
      catalog.errors.push(node.name.text);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["get", "post", "put", "patch", "delete", "all", "use"].includes(
        node.expression.name.text,
      )
    ) {
      const path = node.arguments[0];
      if (
        path &&
        ts.isStringLiteral(path) &&
        path.text.startsWith("/") &&
        !path.text.includes("://")
      )
        catalog.routes.push(path.text);
    }
    if (
      file.endsWith("/log-events.ts") &&
      ts.isTypeAliasDeclaration(node) &&
      ["RequestEventMap", "SystemEventMap"].includes(node.name.text)
    ) {
      const members = ts.isTypeLiteralNode(node.type) ? node.type.members : [];
      for (const member of members)
        if (member.name && (ts.isStringLiteral(member.name) || ts.isIdentifier(member.name)))
          events.push(member.name.text);
    }
    if (
      file.endsWith("/log-events.ts") &&
      ts.isPropertySignature(node) &&
      node.type &&
      node.name
    ) {
      const key = node.name.getText(source).replaceAll('"', "");
      const types = ts.isUnionTypeNode(node.type)
        ? node.type.types
        : [node.type];
      const values = types.map(literal).filter((value) => value !== undefined);
      if (values.length)
        fields[key] = {
          values: [...new Set([...(fields[key]?.values ?? []), ...values])],
        };
      else if (types.some((type) => type.kind === ts.SyntaxKind.BooleanKeyword))
        fields[key] = { kind: "boolean" };
      else if (types.some((type) => type.kind === ts.SyntaxKind.NumberKeyword))
        fields[key] = { kind: "number" };
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (names.size)
    catalog.frames[file.replace(/^(?:sdk|mcpjam-inspector)\//, "")] = [
      ...names,
    ].sort();
}

catalogs.inspector.routeEntries = mountedRoutes("mcpjam-inspector/server/app.ts");
catalogs.inspector.routes = catalogs.inspector.routeEntries.map((entry) => entry.path);
for (const [group, bundle] of [["sdk", "dist/index.js"], ["inspector", "dist/server/index.js"], ["inspector", ".vite/build/main.cjs"]]) {
  const names = Object.entries(catalogs[group].frames).filter(([file]) => group === "sdk" || file.startsWith("server/") || file.startsWith("shared/") || file.startsWith("src/")).flatMap(([, functions]) => functions);
  catalogs[group].frames[bundle] = [...new Set(names)].sort();
}

const outputs = {
  "sdk/src/internal/telemetry-catalog.generated.json": catalogs.sdk,
  "mcpjam-inspector/shared/telemetry-catalog.generated.json": {
    ...catalogs.inspector,
    events,
    fields,
  },
};
for (const [file, catalog] of Object.entries(outputs)) {
  for (const key of ["routes", "errors", "messages"])
    catalog[key] = [...new Set(catalog[key])].sort();
  // Compact generated catalogs avoid thousands of mechanically repeated lines.
  const text = `${JSON.stringify(catalog)}\n`;
  if (process.argv.includes("--check")) {
    if (readFileSync(file, "utf8") !== text)
      throw new Error(`Regenerate telemetry catalog: ${file}`);
  } else writeFileSync(file, text);
}
