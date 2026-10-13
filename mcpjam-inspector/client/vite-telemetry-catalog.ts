import { createHash } from "node:crypto";
import ts from "typescript";
import type { Plugin } from "vite";

/** Catalog exact emitted filenames/functions, including minified names. */
export function emittedFunctionNames(code: string): string[] {
  const names = new Set<string>();
  const source = ts.createSourceFile(
    "bundle.js",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  function visit(node: ts.Node): void {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node)) &&
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
    ts.forEachChild(node, visit);
  }
  visit(source);
  return Array.from(names)
    .flatMap((name) => [
      name,
      `Object.${name}`,
      `Module.${name}`,
      `new ${name}`,
    ])
    .sort();
}

export function telemetryCatalogPlugin(): Plugin {
  return {
    name: "telemetry-build-catalog",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const frames: Record<string, string[]> = {};
      for (const entry of Object.values(bundle)) {
        if (entry.type === "chunk")
          frames[entry.fileName] = emittedFunctionNames(entry.code);
      }
      const data = JSON.stringify(frames).replace(/</g, "\\u003c");
      const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
      const fileName = `assets/telemetry-catalog-${hash}.js`;
      this.emitFile({
        type: "asset",
        fileName,
        source: `Object.defineProperty(globalThis,"__MCPJAM_TELEMETRY_CATALOG__",{value:Object.freeze(Object.fromEntries(Object.entries(${data}).map(([k,v])=>[k,Object.freeze(v)])))})`,
      });
      for (const entry of Object.values(bundle)) {
        if (
          entry.type === "asset" &&
          entry.fileName.endsWith(".html") &&
          typeof entry.source === "string"
        ) {
          entry.source = entry.source.replace(
            "</head>",
            `<script src="/${fileName}"></script></head>`,
          );
        }
      }
    },
  };
}
