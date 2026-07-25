/**
 * Folder-to-ZIP bundling for plugin import (PR INS-1 of
 * docs/plans/openai-plugin-import-cross-repo.md).
 *
 * Local/Electron mode imports a plugin from a directory picked via a
 * `webkitdirectory` input (same pattern as the skills upload dialog). This
 * module turns that selection into:
 *
 *   - an in-memory `PluginFileSource` for the shared `@mcpjam/sdk`
 *     plugin-bundle parser — the SAME parser the backend runs on the uploaded
 *     ZIP, so the client-side preflight `bundleHash` matches the backend's by
 *     construction (the bundle hash is content-defined: an aggregate over
 *     sorted `path NUL contentHash NUL` frames, independent of ZIP metadata,
 *     compression, or entry order); and
 *   - a ZIP `Uint8Array` to upload through the normal import path.
 *
 * Because the hash is content-defined, a folder and a ZIP with identical
 * contents always produce the same bundle hash, whether computed here or by
 * the backend inspect action.
 */

import type {
  ParsedPluginBundle,
  ParsePluginBundleOptions,
  PluginBundleLimits,
  PluginFileSource,
} from "@mcpjam/sdk/plugin-bundle";
import {
  DEFAULT_PLUGIN_BUNDLE_LIMITS,
  parsePluginBundle,
  PluginBundleError,
} from "@mcpjam/sdk/plugin-bundle";

export interface PluginBundleFile {
  /** Bundle-root-relative path with `/` separators (no leading `./`). */
  path: string;
  bytes: Uint8Array;
}

/**
 * OS metadata junk that a directory picker sweeps up but that no plugin
 * bundle should contain. Filtered from FOLDER selections only — a
 * user-supplied ZIP is uploaded as-is and the backend inspect of those exact
 * bytes stays authoritative.
 */
const FOLDER_JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX(\/|$))/;

/**
 * Convert a `webkitdirectory` selection into bundle files. Browser folder
 * selections prefix every `webkitRelativePath` with the picked folder's own
 * name; when every entry shares that single top-level segment it is stripped
 * so the manifest lands at `.codex-plugin/plugin.json` relative to the bundle
 * root, exactly as it would inside a ZIP of the folder's CONTENTS.
 *
 * Limits (`DEFAULT_PLUGIN_BUNDLE_LIMITS`, same constants as the ZIP path and
 * the SDK/backend validators) are enforced from the browser-reported entry
 * count and `File.size` metadata BEFORE any file content is read, so an
 * oversized folder selection is rejected without buffering it into memory.
 * Violations throw the SDK's `PluginBundleError` with the SDK issue codes.
 */
export async function filesFromFolderSelection(
  selection: File[],
  options?: { limits?: Partial<PluginBundleLimits> },
): Promise<PluginBundleFile[]> {
  const limits: PluginBundleLimits = {
    ...DEFAULT_PLUGIN_BUNDLE_LIMITS,
    ...options?.limits,
  };
  const named = selection
    .map((file) => ({
      file,
      path: (
        (file as { webkitRelativePath?: string }).webkitRelativePath ||
        file.name
      ).replace(/\\/g, "/"),
    }))
    .filter((entry) => !FOLDER_JUNK.test(entry.path));

  // Strip the shared top-level folder segment (present iff the paths came
  // from a real directory selection rather than loose files).
  const roots = new Set(
    named.map((entry) => entry.path.split("/", 1)[0] ?? ""),
  );
  const stripRoot =
    roots.size === 1 && named.every((entry) => entry.path.includes("/"));

  const pending: Array<{ path: string; file: File }> = [];
  for (const entry of named) {
    const path = stripRoot
      ? entry.path.slice(entry.path.indexOf("/") + 1)
      : entry.path;
    if (path.length === 0) continue;
    pending.push({ path, file: entry.file });
  }

  // Metadata-only limit pass BEFORE reading a single byte. `buildPluginZip`
  // writes file records only (no directory records), so this entry count is
  // exactly what the backend archive validator will count on the upload.
  if (pending.length > limits.maxEntries) {
    throw bundleLimitError(
      "BUNDLE_TOO_MANY_ENTRIES",
      `selection has ${pending.length} files; the limit is ${limits.maxEntries}`,
    );
  }
  let declaredTotal = 0;
  for (const entry of pending) {
    if (entry.file.size > limits.maxFileBytes) {
      throw bundleLimitError(
        "FILE_TOO_LARGE",
        `file is ${entry.file.size} bytes; the per-file limit is ${limits.maxFileBytes}`,
        entry.path,
      );
    }
    declaredTotal += entry.file.size;
    if (declaredTotal > limits.maxTotalBytes) {
      throw bundleLimitError(
        "BUNDLE_TOO_LARGE",
        `selection exceeds ${limits.maxTotalBytes} bytes of total content`,
      );
    }
  }

  const files: PluginBundleFile[] = [];
  for (const entry of pending) {
    files.push({ path: entry.path, bytes: await readFileBytes(entry.file) });
  }
  return files;
}

/** `Blob.arrayBuffer` with a `FileReader` fallback (older WebKit/jsdom). */
async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * In-memory `PluginFileSource` over already-loaded files. Feed it to the
 * shared SDK parser for client-side preflight validation and the
 * content-defined `bundleHash`.
 */
export function createMemoryPluginFileSource(
  files: PluginBundleFile[],
): PluginFileSource {
  const byPath = new Map(files.map((file) => [file.path, file.bytes]));
  return {
    list: async () =>
      files.map((file) => ({
        path: file.path,
        size: file.bytes.byteLength,
        kind: "file" as const,
      })),
    readBytes: async (path: string, maxBytes: number) => {
      const bytes = byPath.get(path);
      if (bytes === undefined) {
        throw new Error(`no such bundle file: ${path}`);
      }
      // The PluginFileSource contract: adapters MUST enforce maxBytes and
      // throw rather than return oversized (or truncated) data.
      if (bytes.byteLength > maxBytes) {
        throw new Error(
          `bundle file ${path} exceeds the ${maxBytes}-byte read limit`,
        );
      }
      return bytes;
    },
  };
}

/**
 * Parse an in-memory file set with the shared SDK plugin-bundle parser.
 * Throws the SDK's `PluginBundleError` (with every collected issue) on any
 * error-severity finding; the result carries `bundleHash` and warnings.
 */
export async function parsePluginBundleFromFiles(
  files: PluginBundleFile[],
  options?: ParsePluginBundleOptions,
): Promise<ParsedPluginBundle> {
  return parsePluginBundle(createMemoryPluginFileSource(files), options);
}

/** Fixed entry timestamp so repeated zips of the same folder are stable. */
const ZIP_EPOCH = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

/**
 * jszip sniffs input types with `instanceof`, which fails across JS realms
 * (Node vs jsdom in vitest). `Buffer.isBuffer` is realm-safe, so prefer a
 * Buffer in Node-flavored environments; browsers (single realm) pass the
 * Uint8Array straight through.
 */
function toZipInput(bytes: Uint8Array): Uint8Array {
  return typeof Buffer !== "undefined" ? Buffer.from(bytes) : bytes;
}

/**
 * Build an uploadable ZIP from bundle files. Entries are sorted by
 * code-point path order with a fixed timestamp, so zipping the same folder
 * twice yields the same archive on the same machine. (Byte-identical ZIPs are
 * NOT required for hash equality — the bundle hash is computed from entry
 * contents, not archive bytes.)
 */
export async function buildPluginZip(
  files: PluginBundleFile[],
): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  for (const file of sorted) {
    zip.file(file.path, toZipInput(file.bytes), {
      date: ZIP_EPOCH,
      binary: true,
      // File records only: implicit directory records would count against the
      // backend's archive record limit, and `filesFromFolderSelection`'s
      // pre-read entry count assumes the upload contains exactly its files.
      createFolders: false,
    });
  }
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

function bundleLimitError(
  code: "BUNDLE_TOO_MANY_ENTRIES" | "BUNDLE_TOO_LARGE" | "FILE_TOO_LARGE",
  message: string,
  path?: string,
): PluginBundleError {
  return new PluginBundleError([
    {
      code,
      severity: "error",
      message,
      ...(path !== undefined ? { path } : {}),
    },
  ]);
}

/** jszip keeps the central-directory uncompressed size on an internal field. */
function declaredUncompressedSize(entry: unknown): number | undefined {
  const size = (entry as { _data?: { uncompressedSize?: unknown } })._data
    ?.uncompressedSize;
  return typeof size === "number" && size >= 0 ? size : undefined;
}

/** Minimal surface of jszip's (untyped) per-entry internal stream. */
interface JsZipInternalStream {
  on(event: "data", cb: (chunk: Uint8Array) => void): JsZipInternalStream;
  on(event: "end", cb: () => void): JsZipInternalStream;
  on(event: "error", cb: (err: Error) => void): JsZipInternalStream;
  resume(): JsZipInternalStream;
  pause(): JsZipInternalStream;
}

/**
 * Inflate one entry as a bounded stream. The central directory's declared
 * size is attacker-controlled (a bomb can forge it below the caps), so the
 * only trustworthy enforcement is counting ACTUAL inflated bytes as they
 * stream out and aborting mid-entry the moment a cap is crossed — the
 * remainder is never inflated.
 */
function readEntryBounded(
  entry: unknown,
  path: string,
  maxFileBytes: number,
  remainingTotalBytes: number,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const stream = (
      entry as { internalStream(type: "uint8array"): JsZipInternalStream }
    ).internalStream("uint8array");
    const chunks: Uint8Array[] = [];
    let received = 0;
    let settled = false;
    const abort = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.pause();
      reject(error);
    };
    stream
      .on("data", (chunk) => {
        if (settled) return;
        received += chunk.length;
        if (received > maxFileBytes) {
          abort(
            bundleLimitError(
              "FILE_TOO_LARGE",
              `file exceeded the per-file limit of ${maxFileBytes} bytes during extraction`,
              path,
            ),
          );
          return;
        }
        if (received > remainingTotalBytes) {
          abort(
            bundleLimitError(
              "BUNDLE_TOO_LARGE",
              `total uncompressed content exceeded the bundle limit during extraction`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      })
      .on("error", (err) => abort(err))
      .on("end", () => {
        if (settled) return;
        settled = true;
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        resolve(bytes);
      })
      .resume();
  });
}

/**
 * Read a ZIP back into bundle files (directory entries dropped, contents
 * untouched — deliberately NO junk filtering, mirroring the backend's ZIP
 * adapter so a preflight over these files hashes the same bytes the backend
 * will). Used by tests to prove folder/ZIP hash parity and available to the
 * import UI for ZIP preflight.
 *
 * Zip-bomb hardening: extraction enforces the SAME limits the SDK parser and
 * backend archive adapter use (`DEFAULT_PLUGIN_BUNDLE_LIMITS`: 1000 entries,
 * 10 MB per file, 100 MB total uncompressed) DURING inflation. The record
 * count (files AND directories, matching the backend's end-of-central-
 * directory count) is checked before any read; each entry is then inflated
 * as a bounded stream (`readEntryBounded`) that counts ACTUAL bytes and
 * aborts mid-entry when a per-file or cumulative cap is crossed — a forged
 * central-directory size cannot bypass it. The declared size is still used
 * as a cheap fast-fail for honest metadata. Violations throw the SDK's
 * `PluginBundleError` with the matching issue codes
 * (`BUNDLE_TOO_MANY_ENTRIES` / `FILE_TOO_LARGE` / `BUNDLE_TOO_LARGE`), so the
 * UI error path is uniform with parser failures.
 */
export async function zipToPluginFiles(
  zipBytes: Uint8Array,
  options?: { limits?: Partial<PluginBundleLimits> },
): Promise<PluginBundleFile[]> {
  const limits: PluginBundleLimits = {
    ...DEFAULT_PLUGIN_BUNDLE_LIMITS,
    ...options?.limits,
  };
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(toZipInput(zipBytes));

  // Count every archive RECORD, directories included — the backend rejects on
  // the end-of-central-directory record count before filtering, so a client
  // preflight that ignored directory records would accept archives the
  // authoritative validator rejects.
  const allRecords = Object.values(zip.files);
  if (allRecords.length > limits.maxEntries) {
    throw bundleLimitError(
      "BUNDLE_TOO_MANY_ENTRIES",
      `archive has ${allRecords.length} records; the limit is ${limits.maxEntries}`,
    );
  }
  const entries = allRecords.filter((entry) => !entry.dir);

  let totalBytes = 0;
  const files: PluginBundleFile[] = [];
  for (const entry of entries) {
    const path = entry.name.replace(/\\/g, "/");

    // Cheap fast-fail on the DECLARED size (honest metadata never inflates).
    // The declared size is attacker-controlled, so the authoritative
    // enforcement is the bounded stream below, which counts actual bytes.
    const declared = declaredUncompressedSize(entry);
    if (declared !== undefined) {
      if (declared > limits.maxFileBytes) {
        throw bundleLimitError(
          "FILE_TOO_LARGE",
          `file declares ${declared} bytes; the per-file limit is ${limits.maxFileBytes}`,
          path,
        );
      }
      if (totalBytes + declared > limits.maxTotalBytes) {
        throw bundleLimitError(
          "BUNDLE_TOO_LARGE",
          `total uncompressed content exceeds ${limits.maxTotalBytes} bytes`,
        );
      }
    }

    const bytes = await readEntryBounded(
      entry,
      path,
      limits.maxFileBytes,
      limits.maxTotalBytes - totalBytes,
    );
    totalBytes += bytes.byteLength;
    files.push({ path, bytes });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
