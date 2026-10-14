import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const cache = new Map();
const join = (left, right) =>
  `${left}/${right}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
function source(file) {
  if (cache.has(file)) return cache.get(file);
  const tree = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = new Map();
  for (const node of tree.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      !node.moduleSpecifier.text.startsWith(".")
    )
      continue;
    const target = resolve(
      dirname(file),
      node.moduleSpecifier.text.replace(/\.js$/, ""),
    );
    const path = [target + ".ts", target + "/index.ts"].find(existsSync);
    if (!path) continue;
    const clause = node.importClause;
    if (clause?.name) imports.set(clause.name.text, path);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
      for (const binding of clause.namedBindings.elements)
        imports.set(binding.name.text, path);
  }
  const result = { tree, imports };
  cache.set(file, result);
  return result;
}

/** Follow only literal mounts in the source graph, never runtime request paths. */
export function mountedRoutes(entry) {
  const rows = new Map();
  const seen = new Set();
  const visitModule = (file, prefix) => {
    const key = `${file}:${prefix}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { tree, imports } = source(file);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const method = node.expression.name.text;
        const path = node.arguments[0];
        if (
          path &&
          ts.isStringLiteral(path) &&
          (path.text.startsWith("/") || path.text === "*")
        ) {
          const full = join(prefix, path.text);
          if (
            [
              "get",
              "post",
              "put",
              "patch",
              "delete",
              "head",
              "options",
              "all",
              "use",
            ].includes(method)
          ) {
            const verb = ["all", "use"].includes(method)
              ? "ALL"
              : method.toUpperCase();
            rows.set(`${verb} ${full}`, { method: verb, path: full });
          }
          if (method === "route") {
            const child = node.arguments[1];
            const name =
              child &&
              (ts.isIdentifier(child)
                ? child.text
                : ts.isCallExpression(child) &&
                    ts.isIdentifier(child.expression)
                  ? child.expression.text
                  : "");
            if (name && imports.has(name)) visitModule(imports.get(name), full);
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text.startsWith("register") &&
        imports.has(node.expression.text)
      ) {
        visitModule(imports.get(node.expression.text), prefix);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  };
  visitModule(resolve(entry), "");
  return [...rows.values()].sort((a, b) =>
    `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`),
  );
}
