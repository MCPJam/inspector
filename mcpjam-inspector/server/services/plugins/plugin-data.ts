/**
 * The writable per-plugin data directory behind `${PLUGIN_DATA}` (Agent
 * Plugins spec: "Create a dedicated writable PLUGIN_DATA directory before
 * launch and preserve it across plugin updates").
 *
 * Keyed by LOGICAL plugin identity — `<root>/<projectId>/<pluginId>` — never
 * by version or bundle hash: the whole point of the directory is surviving a
 * version activation, so a component's cache/state carries across updates.
 * Contrast with the bundle cache (`bundle-cache.ts`), which is content-
 * addressed, immutable, verified on every hit, and garbage-collected; the
 * data directory is none of those things — it is the component's own mutable
 * scratch space and its contents are never trusted, verified, or executed by
 * MCPJam.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isSafePathSegment } from "./path-segments.js";

export function defaultPluginDataRoot(): string {
  return join(homedir(), ".mcpjam", "plugin-data");
}

/**
 * Resolve and create the data directory for one plugin. Throws on malformed
 * ids rather than joining them into a path: both segments are Convex ids and
 * must never carry separators.
 */
export async function ensurePluginDataDir(args: {
  projectId: string;
  pluginId: string;
  /** Test seam; defaults to `~/.mcpjam/plugin-data`. */
  rootDir?: string;
}): Promise<string> {
  if (
    !isSafePathSegment(args.projectId) ||
    !isSafePathSegment(args.pluginId)
  ) {
    throw new Error(
      `plugin data dir refuses unsafe id segments: ${args.projectId}/${args.pluginId}`
    );
  }
  const dir = join(
    args.rootDir ?? defaultPluginDataRoot(),
    args.projectId,
    args.pluginId
  );
  // Owner-only regardless of umask: persisted plugin state (caches, auth
  // artifacts a component chooses to write) must not be readable by other
  // local users. Applies on creation; an existing directory keeps its mode.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}
