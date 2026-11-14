// Backend collector builds import this file from a sparse Inspector checkout
// and call `mountedRoutes(entry)`. Keep its path, that signature and its
// self-contained imports (typescript and node builtins only) stable.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

// Loaded on the first parse: a warm cache answers without it (about 300 ms).
let ts;
export const loadTypeScript = () => (ts ??= createRequire(import.meta.url)("typescript"));

const VERBS = ["get", "post", "put", "patch", "delete", "head", "options", "all", "use"];
const join = (left, right) =>
  `${left}/${right}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";

/** The literal mounts one file declares, in source order. */
function routeFacts(tree) {
  const imports = [];
  for (const node of tree.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      !node.moduleSpecifier.text.startsWith(".")
    )
      continue;
    const clause = node.importClause;
    const names = [];
    if (clause?.name) names.push(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
      for (const binding of clause.namedBindings.elements) names.push(binding.name.text);
    if (names.length) imports.push([node.moduleSpecifier.text, names]);
  }
  const mounts = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const path = node.arguments[0];
      if (path && ts.isStringLiteral(path) && (path.text.startsWith("/") || path.text === "*")) {
        if (VERBS.includes(method)) mounts.push({ method, path: path.text });
        if (method === "route") {
          const child = node.arguments[1];
          const name =
            child &&
            (ts.isIdentifier(child)
              ? child.text
              : ts.isCallExpression(child) && ts.isIdentifier(child.expression)
                ? child.expression.text
                : "");
          if (name) mounts.push({ method, path: path.text, child: name });
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text.startsWith("register")
    )
      mounts.push({ register: node.expression.text });
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { imports, mounts };
}

/**
 * Per-file facts keyed by (path, mtimeMs, size). Every lookup re-stats the
 * file, so a long-lived cache re-parses only what changed and never returns a
 * deleted or edited file's old facts. `extract` adds caller facts from the
 * same parse.
 */
export function createSourceCache({ extract, entries = new Map() } = {}) {
  const cache = {
    entries,
    used: new Set(),
    parsed: 0,
    facts(file) {
      const { mtimeMs, size } = statSync(file);
      cache.used.add(file);
      const hit = entries.get(file);
      if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.facts;
      loadTypeScript();
      const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const facts = { ...routeFacts(tree), ...extract?.(tree, file) };
      entries.set(file, { mtimeMs, size, facts });
      cache.parsed++;
      return facts;
    },
  };
  return cache;
}

/** Follow only literal mounts in the source graph, never runtime request paths. */
export function mountedRoutes(entry, cache = createSourceCache()) {
  const rows = new Map();
  const seen = new Set();
  const visitModule = (file, prefix) => {
    const key = `${file}:${prefix}`;
    if (seen.has(key)) return;
    seen.add(key);
    const facts = cache.facts(file);
    // Resolved per scan, so a newly created target is followed without a re-parse.
    const imports = new Map();
    for (const [specifier, names] of facts.imports) {
      const target = resolve(dirname(file), specifier.replace(/\.js$/, ""));
      const path = [target + ".ts", target + "/index.ts"].find(existsSync);
      if (path) for (const name of names) imports.set(name, path);
    }
    for (const mount of facts.mounts) {
      if (mount.register) {
        if (imports.has(mount.register)) visitModule(imports.get(mount.register), prefix);
        continue;
      }
      const full = join(prefix, mount.path);
      if (mount.method === "route") {
        if (imports.has(mount.child)) visitModule(imports.get(mount.child), full);
        continue;
      }
      const verb = ["all", "use"].includes(mount.method) ? "ALL" : mount.method.toUpperCase();
      rows.set(`${verb} ${full}`, { method: verb, path: full });
    }
  };
  visitModule(resolve(entry), "");
  return [...rows.values()].sort((a, b) =>
    `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`),
  );
}
