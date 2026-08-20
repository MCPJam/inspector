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
import type { OpenAIArchiveObservations } from "@mcpjam/sdk";

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

/**
 * Archive facts an OpenAI readiness run needs and a `PluginFileSource` cannot
 * carry.
 *
 * The source abstraction is deliberately about CONTENT — list entries, read
 * bytes — and these three are not content. Compressed size, encryption flags
 * and the entry names exactly as the central directory records them exist only
 * for an archive, and the readiness reader treats an absent field as "not
 * observed" rather than "fine", so handing it partial observations is honest
 * rather than lossy.
 */
export async function collectZipArchiveObservations(
  bytes: Uint8Array
): Promise<OpenAIArchiveObservations> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    // AN UNREADABLE ARCHIVE IS THE ENCRYPTED ONE'S USUAL SHAPE. JSZip rejects
    // a password-protected zip outright rather than listing its entries, and
    // an encrypted upload is precisely a case the readiness report must
    // survive: letting the rejection escape turns a gradeable submission into
    // a crashed run, and the one fact this adapter can still state — the
    // uploaded size — is thrown away with it. Every other field stays absent,
    // so the reader reports what it could not read rather than passing it.
    //
    // NOT the same choice as `createZipPluginFileSource` above, which must
    // still throw: its whole contract is to hand back a readable file source,
    // and there is nothing to read here. This function's contract is to report
    // observations, and "unreadable" is one.
    return { compressedBytes: bytes.byteLength };
  }
  return {
    // The uploaded bytes, which is exactly what the portal's compressed-size
    // limit is measured against.
    compressedBytes: bytes.byteLength,
    // RAW names, straight off the entry table. The readiness reader checks the
    // portal's path rules against these BEFORE anything normalizes them,
    // because normalization repairs a backslash separator and a doubled or `.`
    // segment — three of the things the portal rejects.
    rawEntryNames: Object.keys(zip.files),
    // `encryptedEntryPaths` is deliberately ABSENT rather than `[]`. JSZip
    // cannot read an encrypted archive at all, so this adapter has no way to
    // enumerate encrypted entries; reporting an empty list would assert
    // "checked, none found" for a check that never ran.
  };
}

/**
 * A directory source has no archive facts, and that is not a gap to work
 * around.
 *
 * An extracted tree genuinely has no compressed size, no encryption flags, and
 * no pre-normalization names — the extractor already applied the platform's
 * own normalization on the way to disk. Passing this constant states that
 * explicitly at the call site, and the readiness reader turns each absent field
 * into a `not-evaluated` with a reason rather than a silent pass.
 */
export const DIRECTORY_ARCHIVE_OBSERVATIONS: OpenAIArchiveObservations = {};
