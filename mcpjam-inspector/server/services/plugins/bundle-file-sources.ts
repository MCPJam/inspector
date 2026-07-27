/**
 * Node `PluginFileSource` adapters for the local materializer (INS-6).
 *
 * The SDK parser (`@mcpjam/sdk/plugin-bundle`) is filesystem- and
 * archive-library-free ON PURPOSE: every consumer supplies its own source
 * adapter and gets byte-identical normalization, validation and hashing. These
 * are the inspector server's two adapters — the extracted cache directory and
 * the ZIP a desktop import just produced — so the cache never needs its own
 * copy of a single bundle rule (the INS-1 mirror-the-SDK mistake).
 *
 * Both adapters enforce `maxBytes` by THROWING rather than truncating: a
 * truncated read would hash to something the parser would happily accept as a
 * different-but-valid bundle, which is precisely the confusion hash
 * verification exists to prevent.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import JSZip from "jszip";
import type {
  PluginFileEntry,
  PluginFileSource,
} from "@mcpjam/sdk/plugin-bundle";

/** Cache-internal scratch dirs (see `bundle-cache.ts`) are never bundle content. */
const IGNORED_DIR_PREFIX = ".mcpjam-tmp-";

function toBundlePath(root: string, absolute: string): string {
  // The parser's contract is POSIX-style bundle-relative paths; on Windows the
  // relative path arrives with backslashes.
  return relative(root, absolute).split(sep).join("/");
}

async function listDirectory(
  root: string,
  current: string,
  out: PluginFileEntry[]
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(IGNORED_DIR_PREFIX)) continue;
    const absolute = join(current, entry.name);
    const path = toBundlePath(root, absolute);
    // Symlinks are surfaced, never followed: the parser rejects link entries,
    // and following one would let a link inside the cache pull arbitrary host
    // content into a bundle that still hashed "correctly" for its own files.
    if (entry.isSymbolicLink()) {
      out.push({ path, size: 0, kind: "symlink" });
      continue;
    }
    if (entry.isDirectory()) {
      out.push({ path, size: 0, kind: "directory" });
      await listDirectory(root, absolute, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const stats = await lstat(absolute);
    // A regular file with >1 link is a hardlink to content outside the cache;
    // same reasoning as symlinks — surface the kind and let the parser reject.
    out.push({
      path,
      size: stats.size,
      kind: stats.nlink > 1 ? "hardlink" : "file",
    });
  }
}

/** Read an extracted bundle directory (the cache entry). */
export function createDirectoryPluginFileSource(root: string): PluginFileSource {
  return {
    async list() {
      const out: PluginFileEntry[] = [];
      await listDirectory(root, root, out);
      return out;
    },
    async readBytes(path: string, maxBytes: number) {
      const absolute = join(root, path);
      const stats = await lstat(absolute);
      if (stats.size > maxBytes) {
        throw new Error(
          `Bundle file "${path}" is ${stats.size} bytes, over the ${maxBytes} byte limit`
        );
      }
      const buffer = await readFile(absolute);
      return new Uint8Array(buffer);
    },
  };
}

/**
 * Read a plugin ZIP already in memory — the archive a desktop folder import
 * produced (`client/src/lib/plugins/folder-bundle.ts`) and posted to the local
 * materialize route.
 */
export async function createZipPluginFileSource(
  bytes: Uint8Array
): Promise<PluginFileSource> {
  const zip = await JSZip.loadAsync(bytes);
  return {
    async list() {
      const out: PluginFileEntry[] = [];
      zip.forEach((path, entry) => {
        // JSZip has no symlink concept; the parser's path/limit rules still
        // apply, and the extracted copy is re-listed from disk (where links
        // WOULD be visible) before it is accepted.
        out.push({
          path: entry.dir ? path.replace(/\/+$/, "") : path,
          size: (entry as { _data?: { uncompressedSize?: number } })._data
            ?.uncompressedSize ?? 0,
          kind: entry.dir ? "directory" : "file",
        });
      });
      return out;
    },
    async readBytes(path: string, maxBytes: number) {
      const entry = zip.file(path);
      if (!entry) throw new Error(`Bundle file "${path}" is missing`);
      const bytes = await entry.async("uint8array");
      if (bytes.byteLength > maxBytes) {
        throw new Error(
          `Bundle file "${path}" is ${bytes.byteLength} bytes, over the ${maxBytes} byte limit`
        );
      }
      return bytes;
    },
  };
}
