#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const wrapper = "components/announcement-popups.tsx";
const roots = new Map([
  ["@mcpjam/design-system/dialog", "Dialog"],
  ["@mcpjam/design-system/alert-dialog", "AlertDialog"],
  ["@mcpjam/design-system/popover", "Popover"],
  ["@mcpjam/design-system/feature-spotlight", "FeatureSpotlight"],
]);

export function checkAnnouncementPopups(file, code) {
  if (file.replaceAll("\\", "/") === wrapper) return [];
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const imports = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly)
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    const from = statement.moduleSpecifier.text;
    if (ts.isNamespaceImport(bindings)) {
      imports.set(bindings.name.text, [from, "*"]);
    } else {
      for (const { name, propertyName, isTypeOnly } of bindings.elements) {
        if (!isTypeOnly)
          imports.set(name.text, [from, propertyName?.text ?? name.text]);
      }
    }
  }

  const violations = [];
  const report = (node, message) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push(`${file}:${line + 1}: ${message}`);
  };
  const imported = (expression) => {
    if (ts.isIdentifier(expression)) return imports.get(expression.text) ?? [];
    if (ts.isPropertyAccessExpression(expression)) {
      const [from, name] = imported(expression.expression);
      if (name === "*") return [from, expression.name.text];
      if (from === "radix-ui" && expression.name.text === "Root")
        return [from, name];
    }
    return [];
  };
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const [from, name] = imported(node.tagName);
      if (name === "FeatureSpotlight" && roots.get(from) === name) {
        report(node, "Use AnnouncementSpotlight instead of a raw FeatureSpotlight.");
      } else if (
        (name && roots.get(from) === name) ||
        (from === "radix-ui" && ["Dialog", "AlertDialog", "Popover"].includes(name))
      ) {
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || attr.name.getText(source) !== "defaultOpen")
            continue;
          const value = attr.initializer;
          if (!value || !ts.isJsxExpression(value) ||
              value.expression?.kind !== ts.SyntaxKind.FalseKeyword) {
            report(attr, "Queue auto-opening dialogs and popovers with an announcement wrapper.");
          }
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const [from, name] = imported(node.expression.expression);
      if (from === "sonner" && name === "toast" && node.expression.name.text === "custom") {
        report(node, "Use AnnouncementToast instead of calling toast.custom directly.");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["__tests__", "__fixtures__", "test"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\.tsx?$/.test(entry.name)) {
      yield path;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const violations = [...sourceFiles(src)].flatMap((file) =>
    checkAnnouncementPopups(relative(src, file), readFileSync(file, "utf8")),
  );
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("[announcement-popups] OK");
  }
}
