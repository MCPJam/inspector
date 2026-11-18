/**
 * Finds the backend functions a set of source files names.
 *
 * The app often names a Convex function in a config object rather than at a
 * call site (`requestMutation: "serverQuality:requestServerQuality"`), so
 * every string literal shaped `module:function` counts, not only arguments to
 * `useQuery` and friends. Parsed with the TypeScript compiler so a name in a
 * comment does not count.
 *
 * Inspector CI has no backend checkout, so a literal cannot be checked against
 * the backend's function list. Strings that only look like one are dropped by
 * module prefix (`NOT_BACKEND_PREFIXES` in `map.ts`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/** `module:function`, where a module may be a path (`github/checks:list`). */
export const BACKEND_FUNCTION_SHAPE =
  /^[a-z][A-Za-z0-9_]*(\/[A-Za-z0-9_]+)*:[a-z][A-Za-z0-9_]*$/;

const SKIPPED_DIRS = new Set(["__tests__", "__preview__", "__fixtures__"]);

function isSourceFile(name: string): boolean {
  return (
    /\.tsx?$/.test(name) &&
    !name.endsWith(".d.ts") &&
    !/\.(test|spec|stories)\.tsx?$/.test(name)
  );
}

/** Every non-test source file under `dir`. */
export function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : sourceFilesUnder(path);
    }
    return isSourceFile(entry.name) ? [path] : [];
  });
}

/** The non-test source files directly in `dir`, without descending. */
export function sourceFilesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isSourceFile(entry.name))
    .map((entry) => join(dir, entry.name));
}

/** Backend function name → the files (relative to `root`) that name it. */
export function backendNamesIn(
  files: readonly string[],
  root: string,
  notBackendPrefixes: ReadonlySet<string>,
): Map<string, string[]> {
  const found = new Map<string, Set<string>>();
  for (const path of files) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      false,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node)) &&
        BACKEND_FUNCTION_SHAPE.test(node.text) &&
        !notBackendPrefixes.has(node.text.slice(0, node.text.indexOf(":")))
      ) {
        const files = found.get(node.text) ?? new Set<string>();
        files.add(relative(root, path));
        found.set(node.text, files);
      }
      node.forEachChild(visit);
    };
    visit(source);
  }
  return new Map(
    [...found].map(([name, files]) => [name, [...files].sort()] as const),
  );
}
