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
 * The map key is the bundle-relative POSIX path exactly as it should appear in
 * the archive (e.g. `.codex-plugin/plugin.json`, `skills/foo/SKILL.md`). The
 * parser owns path validation; this adapter only surfaces entries and bytes.
 */

import type {
  PluginFileEntry,
  PluginFileSource,
} from "@mcpjam/sdk/plugin-bundle";

/** A plugin folder flattened to bundle-relative path → exact file bytes. */
export type PluginFolderFiles = ReadonlyMap<string, Uint8Array>;

/** One selected file plus its bundle-relative path. */
export interface PluginFolderFile {
  /** Bundle-relative POSIX path (no leading slash, no `..`). */
  path: string;
  bytes: Uint8Array;
}

/**
 * Build a `PluginFileSource` over an in-memory file map. Paths are surfaced
 * verbatim; the parser rejects anything unsafe. `readBytes` enforces `maxBytes`
 * by throwing (never truncating) so hashes are computed over full content.
 */
export function createFolderPluginSource(
  files: PluginFolderFiles,
): PluginFileSource {
  const entries: PluginFileEntry[] = [...files.entries()].map(
    ([path, bytes]) => ({ path, size: bytes.byteLength, kind: "file" }),
  );

  return {
    async list(): Promise<PluginFileEntry[]> {
      return entries;
    },
    async readBytes(path: string, maxBytes: number): Promise<Uint8Array> {
      const bytes = files.get(path);
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
 * webkitdirectory>` FileList, or drag-and-drop entries the caller has already
 * flattened) into a `PluginFolderFiles` map.
 *
 * `webkitRelativePath` includes the chosen root directory as its first segment
 * (`my-plugin/.codex-plugin/plugin.json`); we strip that single leading segment
 * so the map keys are bundle-relative, matching what a ZIP of the folder's
 * CONTENTS would contain. This keeps the folder bundle hash identical to a ZIP
 * built from the same contents.
 */
export async function readBrowserFolderSelection(
  fileList: ArrayLike<File>,
): Promise<PluginFolderFiles> {
  const files = new Map<string, Uint8Array>();
  const list = Array.from(fileList);
  for (const file of list) {
    const relative = (file as File & { webkitRelativePath?: string })
      .webkitRelativePath;
    const rawPath = relative && relative.length > 0 ? relative : file.name;
    const path = stripLeadingDirectory(rawPath);
    if (path.length === 0) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    files.set(path, bytes);
  }
  return files;
}

/**
 * Build a `PluginFolderFiles` map from explicit path/bytes pairs (e.g. an
 * Electron main-process directory walk that already produced bundle-relative
 * POSIX paths).
 */
export function toPluginFolderFiles(
  files: Iterable<PluginFolderFile>,
): PluginFolderFiles {
  const map = new Map<string, Uint8Array>();
  for (const { path, bytes } of files) {
    const normalized = normalizePosixPath(path);
    if (normalized.length === 0) continue;
    map.set(normalized, bytes);
  }
  return map;
}

/** Strip the first path segment (the selected root directory name). */
function stripLeadingDirectory(rawPath: string): string {
  const posix = normalizePosixPath(rawPath);
  const slash = posix.indexOf("/");
  return slash === -1 ? "" : posix.slice(slash + 1);
}

/** Normalize separators and trim leading `./` and `/`. */
function normalizePosixPath(rawPath: string): string {
  let posix = rawPath.replace(/\\/g, "/");
  while (posix.startsWith("./")) posix = posix.slice(2);
  while (posix.startsWith("/")) posix = posix.slice(1);
  return posix;
}
