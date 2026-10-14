import { mountedRoutes } from "./telemetry-route-catalog.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

// First-party source participates; runtime text never adds a name.
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "sdk/src", "mcpjam-inspector"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(
    (file) =>
      /\.[cm]?tsx?$/.test(file) && existsSync(file) &&
      !/(?:__tests__|\.test\.|\.generated\.|\/tests\/)/.test(file),
  );
const catalogs = {
  sdk: { files: [], routes: [], errors: [], messages: [] },
  inspector: { files: [], routes: [], errors: [], messages: [] },
};
const fields = {};
const events = [];
const browserRoutes = [];
const browserMessages = [];
const slugs = [];
const diagnosticCodes = [];
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
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ["V1_ERROR_CODES", "AI_EXECUTION_REFUSAL_CODES", "AI_REUSED_REFUSAL_CODES", "PLATFORM_V1_ERROR_CODES", "ROUTINE_CODES", "ORG_POLICY_ROUTINE_CODES"].includes(node.name.getText(source))) {
      const collect = (child) => { if (ts.isStringLiteral(child)) diagnosticCodes.push(child.text); else ts.forEachChild(child, collect); };
      if (node.initializer) collect(node.initializer);
    }
    if (file === "sdk/src/error-describer/catalog.ts" && ts.isVariableDeclaration(node) && node.name.getText(source) === "ERROR_CATALOG" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties)
        if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name)) slugs.push(property.name.text);
    }
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
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = node.expression.expression.getText(source);
      const method = node.expression.name.text;
      const message = node.arguments[0];
      if ((method === "captureMessage" || (owner === "logger" && ["error", "warn", "info", "debug"].includes(method))) && message && ts.isStringLiteral(message)) {
        catalog.messages.push(message.text);
        if (file.includes("/client/") || file.includes("/shared/")) browserMessages.push(message.text);
      }
    }
    if (file.endsWith("/client/src/lib/app-routes.ts") && ts.isObjectLiteralExpression(node)) {
      const values = Object.fromEntries(node.properties.flatMap((property) =>
        ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)
          ? [[property.name.getText(source), property.initializer.text]] : []));
      if (typeof values.path === "string" && values.scope)
        browserRoutes.push(`${values.scope === "project" ? "/p/:projectId" : ""}/${values.path}`);
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
  catalog.files.push(file.replace(/^(?:sdk|mcpjam-inspector)\//, ""));
}

catalogs.inspector.routeEntries = mountedRoutes("mcpjam-inspector/server/app.ts");
catalogs.inspector.routes = catalogs.inspector.routeEntries.map((entry) => entry.path);
const sdkBuild = ts.createSourceFile("sdk/tsup.config.ts", readFileSync("sdk/tsup.config.ts", "utf8"), ts.ScriptTarget.Latest, true);
const collectSdkEntries = (node) => {
  if (ts.isPropertyAssignment(node) && node.name.getText(sdkBuild) === "entry" && ts.isArrayLiteralExpression(node.initializer)) {
    for (const entry of node.initializer.elements) {
      if (ts.isStringLiteral(entry) && /^src\/.+\.ts$/.test(entry.text))
        catalogs.sdk.files.push(entry.text.replace(/^src\//, "dist/").replace(/\.ts$/, ".js"));
    }
  }
  ts.forEachChild(node, collectSdkEntries);
};
collectSdkEntries(sdkBuild);
catalogs.inspector.files.push("dist/server/index.js", ".vite/build/main.cjs");
const diagnosticFields = { code: [...new Set(diagnosticCodes)].sort(), scope: ["user", "organization", "platform"] };

const outputs = {
  "sdk/src/internal/telemetry-catalog.generated.json": { ...catalogs.sdk, slugs, diagnosticFields },
  "mcpjam-inspector/shared/telemetry-catalog.generated.json": {
    ...catalogs.inspector,
    messages: [...catalogs.inspector.messages, ...events],
    slugs,
    diagnosticFields,
    events: [...new Set(events)].sort(),
    fields,
  },
};
outputs["mcpjam-inspector/shared/browser-telemetry-catalog.generated.json"] = {
  files: [], errors: catalogs.inspector.errors, messages: browserMessages, routes: browserRoutes, slugs, diagnosticFields,
};
outputs["mcpjam-inspector/shared/browser-telemetry-source-files.generated.json"] = catalogs.inspector.files.filter((file) => /^(client|shared)\//.test(file)).sort();
for (const [file, catalog] of Object.entries(outputs)) {
  if (!Array.isArray(catalog)) for (const key of ["files", "routes", "errors", "messages"])
    catalog[key] = [...new Set(catalog[key])].sort();
  // Compact generated catalogs avoid thousands of mechanically repeated lines.
  const text = `${JSON.stringify(catalog)}\n`;
  if (process.argv.includes("--check")) {
    if (readFileSync(file, "utf8") !== text)
      throw new Error(`Regenerate telemetry catalog: ${file}`);
  } else writeFileSync(file, text);
}
