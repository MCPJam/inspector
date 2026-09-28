#!/usr/bin/env node
// Shared viewing code accepts capabilities and callbacks, never product/deployment globals.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import ts from "typescript";
const root = fileURLToPath(new URL("../", import.meta.url));
const files = [
  "src/components/browser/BrowserPaneSurface.tsx",
  ...readdirSync(resolve(root, "src/lib/browser-pane"))
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => `src/lib/browser-pane/${f}`),
];
const violations = [];
for (const file of files) {
  const ast = ts.createSourceFile(
    file,
    readFileSync(resolve(root, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node) => {
    if (
      ts.isIdentifier(node) &&
      ["HOSTED_MODE", "isElectron"].includes(node.text)
    )
      violations.push(`${file}: deployment global ${node.text}`);
    if (
      ts.isStringLiteral(node) &&
      /(?:^|\/)(?:stores|contexts|local-browser|hosted-browser|webmcp-inspector|client-config)(?:\/|$)/.test(
        node.text,
      )
    )
      violations.push(`${file}: product dependency ${node.text}`);
    ts.forEachChild(node, visit);
  };
  visit(ast);
}
if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log(`[browser-viewer-guard] OK: ${files.length} shared modules`);
