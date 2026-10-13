import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { SourceMap } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Only emitted labels whose mapped source belongs to the source catalog. */
export function generateTelemetryFrames(bundle, root = sdkRoot) {
  const text = readFileSync(bundle, "utf8");
  const source = ts.createSourceFile(
    bundle,
    text,
    ts.ScriptTarget.Latest,
    true
  );
  const map = new SourceMap(JSON.parse(readFileSync(`${bundle}.map`, "utf8")));
  const catalog = JSON.parse(
    readFileSync(
      resolve(root, "src/internal/telemetry-catalog.generated.json"),
      "utf8"
    )
  );
  const functions = new Set();
  const owned = (node) => {
    const point = source.getLineAndCharacterOfPosition(node.getStart(source));
    const entry = map.findEntry(point.line, point.character);
    // findEntry may carry a previous token forward across unrelated generated code.
    if (
      entry.generatedLine !== point.line ||
      entry.generatedColumn !== point.character
    )
      return false;
    const original = entry.originalSource;
    if (!original) return false;
    const file = relative(root, resolve(dirname(bundle), original));
    return Object.hasOwn(catalog.frames, file);
  };
  const nameOf = (node) =>
    node && ts.isIdentifier(node) ? node.text : undefined;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && owned(node.name))
      functions.add(node.name.text);
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer)) &&
      owned(node.initializer)
    ) {
      const name = nameOf(node.name);
      if (name) functions.add(name);
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const name =
        nameOf(node.name) ??
        (ts.isVariableDeclaration(node.parent)
          ? nameOf(node.parent.name)
          : undefined);
      if (name) {
        if (owned(node.name ?? node)) functions.add(`new ${name}`);
        for (const member of node.members) {
          if (ts.isConstructorDeclaration(member) && owned(member))
            functions.add(`new ${name}`);
          if (ts.isMethodDeclaration(member) && owned(member)) {
            const method = nameOf(member.name);
            if (method) functions.add(`${name}.${method}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const manifest = {
    version: 1,
    bundle: "dist/index.js",
    sha256: createHash("sha256").update(text).digest("hex"),
    functions: [...functions].sort(),
  };
  writeFileSync(
    resolve(dirname(bundle), "telemetry-frames.generated.json"),
    `${JSON.stringify(manifest)}\n`
  );
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  generateTelemetryFrames(resolve(sdkRoot, "dist/index.js"));
