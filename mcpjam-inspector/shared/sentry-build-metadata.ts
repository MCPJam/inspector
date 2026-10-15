import { readFileSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { sentryInjectedDebugId } from "./strict-sentry.js";

/**
 * Exact spellings of fixed files under a verified root: the native path of
 * CommonJS frames, the module URL of ESM frames, and the forward-slash path
 * Sentry's Node parser derives from that URL. On Windows all three differ.
 */
export function sentryFrameAliases(
  root: string,
  files: readonly string[],
  windows = process.platform === "win32",
) {
  const path = windows ? win32 : posix;
  return Object.fromEntries(
    files.flatMap((file) => {
      const native = path.resolve(root, file);
      const aliases = [
        native,
        native.split(path.sep).join("/"),
        pathToFileURL(native, { windows }).href,
      ];
      return aliases.map((alias) => [alias, file]);
    }),
  );
}

/** Files are fixed package-owned bundle names supplied by each runtime. */
export function sentryBuildMetadata(
  root: string,
  files: readonly string[],
  windows?: boolean,
) {
  const frameDebugIds: Record<string, string> = {};
  const frameOutputNames: Record<string, string> = {};
  const frameAliases: Record<string, string> = sentryFrameAliases(
    root,
    files,
    windows,
  );
  for (const file of files) {
    const canonical = `app:///${file}`;
    frameOutputNames[file] = canonical;
    frameAliases[canonical] = file;
    try {
      const id = sentryInjectedDebugId(
        readFileSync(resolve(root, file), "utf8"),
      );
      if (id) frameDebugIds[canonical] = id;
    } catch {
      // Source checkouts and builds without injected maps retain file/line diagnostics.
    }
  }
  return { frameAliases, frameOutputNames, frameDebugIds };
}
