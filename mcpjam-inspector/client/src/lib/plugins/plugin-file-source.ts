/**
 * Browser-safe folder adapters for the SDK plugin-bundle parser.
 *
 * The `@mcpjam/sdk/plugin-bundle` parser is pure — it consumes an abstract
 * `PluginFileSource` and never touches a filesystem or archive library. This
 * module provides an in-memory folder source so local/Electron mode can parse
 * and preview a selected plugin folder with the SAME normalization, validation,
 * and deterministic hashing the backend applies to an uploaded ZIP (locked
 * decision 3 of docs/plans/openai-plugin-import-cross-repo.md).
 *
 * SECURITY: this adapter surfaces entry paths VERBATIM and does NOT collapse
 * duplicates. The SDK parser owns archive-safety validation — absolute paths,
 * `..` traversal, duplicate normalized paths, case-fold collisions, etc. A Map
 * keyed by path (which silently de-duplicates and demands pre-normalized keys)
 * would hide `PATH_ABSOLUTE` / `PATH_DUPLICATE` from the parser on the folder
 * path, reopening the exact gap the parser exists to close — so files are held
 * as an ARRAY and paths reach the parser unmodified.
 */

import type {
  PluginFileEntry,
  PluginFileSource,
} from "@mcpjam/sdk/plugin-bundle";

/** One selected file plus its bundle-relative path (verbatim, unvalidated). */
export interface PluginFolderFile {
  /** Bundle-relative path as selected; validated by the SDK parser, not here. */
  path: string;
  bytes: Uint8Array;
}

/**
 * A plugin folder flattened to (path, bytes) entries. An ARRAY, not a Map, so
 * duplicate and absolute paths survive to the parser instead of being silently
 * merged or normalized away.
 */
export type PluginFolderFiles = ReadonlyArray<PluginFolderFile>;

/**
 * Build a `PluginFileSource` over an in-memory folder. Entries (including
 * duplicates) and their paths are surfaced exactly as given; the parser
 * rejects anything unsafe. `readBytes` enforces `maxBytes` by throwing (never
 * truncating) so hashes are computed over full content.
 */
export function createFolderPluginSource(
  files: PluginFolderFiles,
): PluginFileSource {
  const entries: PluginFileEntry[] = files.map((file) => ({
    path: file.path,
    size: file.bytes.byteLength,
    kind: "file",
  }));

  const findFirst = (path: string): Uint8Array | undefined =>
    files.find((file) => file.path === path)?.bytes;

  return {
    async list(): Promise<PluginFileEntry[]> {
      return entries;
    },
    async readBytes(path: string, maxBytes: number): Promise<Uint8Array> {
      const bytes = findFirst(path);
      if (bytes === undefined) {
        throw new Error(`plugin file not found: ${path}`);
      }
      if (bytes.byteLength > maxBytes) {
        throw new Error(
          `plugin file exceeds ${maxBytes} bytes: ${path} (${bytes.byteLength})`,
        );
      }
      return bytes;
    },
    async readText(path: string, maxBytes: number): Promise<string> {
      const bytes = await this.readBytes(path, maxBytes);
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    },
  };
}

/**
 * Normalize a browser directory selection (an `<input type="file"
 * webkitdirectory>` FileList, or drag-and-drop files) into `PluginFolderFiles`.
 *
 * `webkitRelativePath` prefixes the chosen root directory as its first segment
 * (`my-plugin/.codex-plugin/plugin.json`); we strip that single leading segment
 * so paths are bundle-relative, matching a ZIP of the folder's CONTENTS. When
 * `webkitRelativePath` is absent (drag-and-drop / fallback), the file's `name`
 * is used as-is — otherwise the whole import would come back empty. Everything
 * after the root segment is preserved verbatim (leading `/`, `..`, duplicates)
 * for the SDK parser to validate.
 */
export async function readBrowserFolderSelection(
  fileList: ArrayLike<File>,
): Promise<PluginFolderFiles> {
  const files: PluginFolderFile[] = [];
  for (const file of Array.from(fileList)) {
    const relative = (file as File & { webkitRelativePath?: string })
      .webkitRelativePath;
    const path =
      relative && relative.length > 0
        ? stripFirstSegment(relative)
        : file.name;
    if (path.length === 0) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    files.push({ path, bytes });
  }
  return files;
}

/**
 * Build `PluginFolderFiles` from explicit path/bytes pairs (e.g. an Electron
 * main-process directory walk). Paths are preserved EXACTLY — no stripping, no
 * de-duplication — so the SDK parser can reject absolute/duplicate/traversal
 * paths a walker might surface.
 */
export function toPluginFolderFiles(
  files: Iterable<PluginFolderFile>,
): PluginFolderFiles {
  return [...files];
}

/** Strip only the first `/`-delimited segment (the selected root directory). */
function stripFirstSegment(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}
