/**
 * Whether a folder is outside the repository this code runs from. A web
 * client's browser profile holds a signed-in session, so it never lives where
 * a commit could pick it up. Node built-ins only, so a script can import it
 * before it loads any server code.
 */
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The folder above `mcpjam-inspector/`. This file sits as deep under
 * `mcpjam-inspector/` as the server bundle (`dist/server/`) and the desktop
 * app's main bundle (`.vite/build/`), so the same climb finds it from source
 * and from either build.
 */
export const REPOSITORY_ROOT = fileURLToPath(
  new URL("../../..", import.meta.url),
);

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
  const fromRoot = paths.relative(root, folder);
  return (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(fromRoot)
  );
}
