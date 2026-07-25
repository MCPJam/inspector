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
  PluginFileSource,
} from "@mcpjam/sdk/plugin-bundle";
import { parsePluginBundle } from "@mcpjam/sdk/plugin-bundle";

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
 */
export async function filesFromFolderSelection(
  selection: File[],
): Promise<PluginBundleFile[]> {
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

  const files: PluginBundleFile[] = [];
  for (const entry of named) {
    const path = stripRoot
      ? entry.path.slice(entry.path.indexOf("/") + 1)
      : entry.path;
    if (path.length === 0) continue;
    files.push({ path, bytes: await readFileBytes(entry.file) });
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
    readBytes: async (path: string) => {
      const bytes = byPath.get(path);
      if (bytes === undefined) {
        throw new Error(`no such bundle file: ${path}`);
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
    });
  }
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

/**
 * Read a ZIP back into bundle files (directory entries dropped, contents
 * untouched — deliberately NO junk filtering, mirroring the backend's ZIP
 * adapter so a preflight over these files hashes the same bytes the backend
 * will). Used by tests to prove folder/ZIP hash parity and available to the
 * import UI for ZIP preflight.
 */
export async function zipToPluginFiles(
  zipBytes: Uint8Array,
): Promise<PluginBundleFile[]> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(toZipInput(zipBytes));
  const files: PluginBundleFile[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    files.push({
      path: entry.name.replace(/\\/g, "/"),
      bytes: await entry.async("uint8array"),
    });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
