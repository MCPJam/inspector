/**
 * Whether a folder is outside the repository this code runs from. A web
 * client's browser profile holds a signed-in session, so it never lives where
 * a commit could pick it up. Node built-ins only, so a script can import it
 * before it loads any server code.
 */
import { createRequire } from "node:module";
import { dirname, posix, win32 } from "node:path";

/**
 * The folder above `mcpjam-inspector/`, found through the package's own
 * `package.json`, so it is the same from source, the server bundle and the
 * desktop app. Undefined when the package can't resolve itself: no checkout
 * holds this code then, so no folder is inside one.
 */
export const REPOSITORY_ROOT: string | undefined = (() => {
  try {
    const manifest = createRequire(import.meta.url).resolve(
      "@mcpjam/inspector/package.json",
    );
    return dirname(dirname(manifest));
  } catch {
    // A bundle that leaves out the package's manifest isn't a checkout.
    return undefined;
  }
})();

/**
 * Whether `folder` is outside `root`. On Windows a folder on another drive
 * has no path relative to the repository, and `relative` answers with the
 * folder's absolute path.
 */
export function isOutsideRepository(
  folder: string,
  {
    root = REPOSITORY_ROOT,
    paths = process.platform === "win32" ? win32 : posix,
  } = {},
): boolean {
  if (root === undefined) return true;
  const fromRoot = paths.relative(root, folder);
  return (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(fromRoot)
  );
}
