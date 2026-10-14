import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sentryInjectedDebugId } from "./strict-sentry.js";

/** Files are fixed package-owned bundle names supplied by each runtime. */
export function sentryBuildMetadata(root: string, files: readonly string[]) {
  const frameDebugIds: Record<string, string> = {};
  const frameOutputNames: Record<string, string> = {};
  const frameAliases: Record<string, string> = {};
  for (const file of files) {
    const canonical = `app:///${file}`;
    const path = resolve(root, file);
    frameOutputNames[file] = canonical;
    for (const alias of [path, pathToFileURL(path).href, canonical])
      frameAliases[alias] = file;
    try {
      const id = sentryInjectedDebugId(readFileSync(path, "utf8"));
      if (id) frameDebugIds[canonical] = id;
    } catch {
      // Source checkouts and builds without injected maps retain file/line diagnostics.
    }
  }
  return { frameAliases, frameOutputNames, frameDebugIds };
}
