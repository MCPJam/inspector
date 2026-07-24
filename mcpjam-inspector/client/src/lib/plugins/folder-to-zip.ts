/**
 * Deterministic, dependency-free folder → ZIP for local/Electron plugin import.
 *
 * In desktop/local mode the client zips a selected plugin folder before upload
 * so the backend receives the SAME canonical input as a hosted ZIP upload
 * (scope decision in docs/plans/openai-plugin-import-cross-repo.md, "V1 import
 * sources"). The plugin bundle hash is content-addressed by the SDK parser
 * (SHA-256 over sorted `path NUL contentHash` framing — see
 * sdk/src/plugin-bundle/hashes.ts), so it depends only on the set of
 * {path, bytes} the archive yields, never on the container's bytes, ordering,
 * or compression. A folder and a ZIP of identical contents therefore produce
 * an identical bundle hash regardless of how this writer lays the ZIP out.
 *
 * The writer uses the STORE method (no compression): a plugin bundle is capped
 * at 25 MB compressed / 100 MB uncompressed and is inspected once, so the
 * simplicity and zero-dependency footprint outweigh compression. Entries are
 * emitted in sorted path order so the produced bytes are deterministic for a
 * given input (useful for tests and content caching). Browser-safe: no Node
 * APIs, only typed arrays and TextEncoder.
 *
 * TRADEOFF (deflate is intentionally out of scope for INS-1): because STORE
 * does not compress, `folderToZip` first runs `assertFolderWithinLimits` — a
 * preflight against the SDK's uncompressed bundle limits — so an oversized
 * folder fails fast with a clear error instead of blowing up memory while
 * materializing the archive. STORE also adds ~per-entry header overhead, so a
 * folder whose CONTENT is just under the backend's 25 MB *compressed* cap can
 * still be rejected on upload; the backend remains the authority on the
 * compressed cap. If large real-world plugins hit this, add deflate here.
 */

import {
  DEFAULT_PLUGIN_BUNDLE_LIMITS,
  type PluginBundleLimits,
} from "@mcpjam/sdk/plugin-bundle";
import type { PluginFolderFiles } from "./plugin-file-source";

/** Stable error code thrown when a folder exceeds the SDK bundle limits. */
export const PLUGIN_FOLDER_TOO_LARGE = "PLUGIN_FOLDER_TOO_LARGE";

export class PluginFolderTooLargeError extends Error {
  readonly code = PLUGIN_FOLDER_TOO_LARGE;
  constructor(message: string) {
    super(message);
    this.name = "PluginFolderTooLargeError";
  }
}

/**
 * Preflight a folder against the SDK's uncompressed bundle limits (entry count,
 * per-file size, total size) BEFORE materializing the archive in memory. Mirror
 * of the archive-level caps the parser/backend enforce, applied early so an
 * oversized selection cannot OOM the STORE writer. Throws
 * `PluginFolderTooLargeError`; the parser still enforces the same caps on the
 * uploaded archive as the authoritative check.
 */
export function assertFolderWithinLimits(
  files: PluginFolderFiles,
  limits: PluginBundleLimits = DEFAULT_PLUGIN_BUNDLE_LIMITS,
): void {
  if (files.length > limits.maxEntries) {
    throw new PluginFolderTooLargeError(
      `plugin folder has ${files.length} files; the limit is ${limits.maxEntries}`,
    );
  }
  let total = 0;
  for (const file of files) {
    if (file.bytes.byteLength > limits.maxFileBytes) {
      throw new PluginFolderTooLargeError(
        `plugin file "${file.path}" is ${file.bytes.byteLength} bytes; the per-file limit is ${limits.maxFileBytes}`,
      );
    }
    total += file.bytes.byteLength;
    if (total > limits.maxTotalBytes) {
      throw new PluginFolderTooLargeError(
        `plugin folder exceeds the ${limits.maxTotalBytes}-byte uncompressed limit`,
      );
    }
  }
}

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
/** General-purpose bit 11: filename/comment are UTF-8. */
const UTF8_FLAG = 0x0800;
/** Method 0 = stored (no compression). */
const METHOD_STORE = 0;
/** Fixed DOS timestamp (1980-01-01 00:00:00) for reproducible archives. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface StagedEntry {
  nameBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
  localHeaderOffset: number;
}

/**
 * Zip a plugin folder (array of bundle-relative path → bytes) into a single ZIP
 * byte array. Directory entries are implied by file paths and are not written;
 * the SDK parser derives structure from file paths. Duplicate paths are written
 * verbatim (the parser rejects them). Throws `PluginFolderTooLargeError` when
 * the folder exceeds the SDK's uncompressed limits.
 */
export function folderToZip(files: PluginFolderFiles): Uint8Array<ArrayBuffer> {
  assertFolderWithinLimits(files);

  const encoder = new TextEncoder();
  // Sorted by path for deterministic output; the bundle hash is
  // order-independent but stable bytes make the archive itself reproducible.
  // A stable sort preserves the relative order of any duplicate paths.
  const ordered = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  const staged: StagedEntry[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;

  for (const { path, bytes: data } of ordered) {
    const nameBytes = encoder.encode(path);
    const crc = crc32(data);

    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, LOCAL_FILE_HEADER_SIG, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, UTF8_FLAG, true);
    view.setUint16(8, METHOD_STORE, true);
    view.setUint16(10, DOS_TIME, true);
    view.setUint16(12, DOS_DATE, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true); // compressed size (== uncompressed)
    view.setUint32(22, data.length, true); // uncompressed size
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true); // extra field length
    header.set(nameBytes, 30);

    staged.push({ nameBytes, data, crc, localHeaderOffset: offset });
    chunks.push(header);
    chunks.push(data);
    offset += header.length + data.length;
  }

  const centralDirStart = offset;
  for (const entry of staged) {
    const record = new Uint8Array(46 + entry.nameBytes.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, CENTRAL_DIR_HEADER_SIG, true);
    view.setUint16(4, 20, true); // version made by
    view.setUint16(6, 20, true); // version needed
    view.setUint16(8, UTF8_FLAG, true);
    view.setUint16(10, METHOD_STORE, true);
    view.setUint16(12, DOS_TIME, true);
    view.setUint16(14, DOS_DATE, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.data.length, true); // compressed size
    view.setUint32(24, entry.data.length, true); // uncompressed size
    view.setUint16(28, entry.nameBytes.length, true);
    view.setUint16(30, 0, true); // extra field length
    view.setUint16(32, 0, true); // comment length
    view.setUint16(34, 0, true); // disk number start
    view.setUint16(36, 0, true); // internal attributes
    view.setUint32(38, 0, true); // external attributes
    view.setUint32(42, entry.localHeaderOffset, true);
    record.set(entry.nameBytes, 46);
    chunks.push(record);
    offset += record.length;
  }
  const centralDirSize = offset - centralDirStart;

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIR_SIG, true);
  endView.setUint16(4, 0, true); // disk number
  endView.setUint16(6, 0, true); // central dir start disk
  endView.setUint16(8, staged.length, true); // entries on this disk
  endView.setUint16(10, staged.length, true); // total entries
  endView.setUint32(12, centralDirSize, true);
  endView.setUint32(16, centralDirStart, true);
  endView.setUint16(20, 0, true); // comment length
  chunks.push(end);
  offset += end.length;

  const out = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

/** Convenience: zip a folder and wrap it as a `Blob` ready for upload. */
export function folderToZipBlob(files: PluginFolderFiles): Blob {
  // `folderToZip` returns a Uint8Array backed by its own freshly-allocated
  // buffer, so Blob can take it directly.
  return new Blob([folderToZip(files)], { type: "application/zip" });
}
