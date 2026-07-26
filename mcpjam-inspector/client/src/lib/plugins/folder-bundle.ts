/**
 * Client-side plugin bundle adapters (PR INS-1 of
 * docs/plans/openai-plugin-import-cross-repo.md).
 *
 * ARCHITECTURE — thin adapters over the shared rulebook, not a parallel
 * validator. This module mirrors the backend's shape (mcpjam-backend
 * convex/lib/pluginArchive.ts): the adapter layers (jszip for ZIPs, the File
 * API for folder selections) only surface RAW entry facts — the unsanitized
 * entry name, link kind from unix mode bits, declared sizes — as
 * `PluginFileSource` implementations, and the shared `@mcpjam/sdk`
 * plugin-bundle parser judges them. Every entry-level rule (traversal,
 * absolute paths, NUL/control characters, duplicate and case-colliding
 * normalized paths, link entries, path length/depth, per-file/total/entry
 * count limits, declared-vs-actual sizes, and everything downstream:
 * manifest, skills, MCP config) runs through the SAME
 * `parsePluginBundle`/`validateBundleEntries` code the backend inspect
 * action runs, so a bundle rejected here is rejected there with the same
 * issue codes, a bundle accepted here passes the shared validation there,
 * and future SDK checks apply client-side with zero changes here.
 *
 * The ONLY client-side logic outside the shared parser is the
 * "CLIENT-ONLY ARCHIVE SCREEN" block below (structural jszip gaps +
 * renderer-memory protection, mirroring the backend's archive adapter) and
 * the folder-selection UI mapping (junk filter + root strip).
 */

import type {
  ParsedPluginBundle,
  ParsePluginBundleOptions,
  PluginBundleLimits,
  PluginFileEntry,
  PluginFileSource,
  PluginValidationIssue,
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

function resolveLimits(options?: ParsePluginBundleOptions): PluginBundleLimits {
  return { ...DEFAULT_PLUGIN_BUNDLE_LIMITS, ...options?.limits };
}

function issueError(
  code: PluginValidationIssue["code"],
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
 * jszip sniffs input types with `instanceof`, which fails across JS realms
 * (Node vs jsdom in vitest). `Buffer.isBuffer` is realm-safe, so prefer a
 * Buffer in Node-flavored environments; browsers (single realm) pass the
 * Uint8Array straight through.
 */
function toZipInput(bytes: Uint8Array): Uint8Array {
  return typeof Buffer !== "undefined" ? Buffer.from(bytes) : bytes;
}

// ---------------------------------------------------------------------------
// Folder selection (webkitdirectory) — UI mapping + raw-facts source.
// ---------------------------------------------------------------------------

/**
 * OS metadata junk that a directory picker sweeps up but that no plugin
 * bundle should contain. Filtered from FOLDER selections only — a
 * user-supplied ZIP is uploaded as-is and the backend inspect of those exact
 * bytes stays authoritative.
 */
const FOLDER_JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX(\/|$))/;

/**
 * Map a `webkitdirectory` selection to bundle-relative paths. Browser folder
 * selections prefix every `webkitRelativePath` with the picked folder's own
 * name; when every entry shares that single top-level segment it is stripped
 * so the manifest lands at `.codex-plugin/plugin.json` relative to the
 * bundle root, exactly as it would inside a ZIP of the folder's CONTENTS.
 * This is a UI affordance mapping, not validation — the shared parser judges
 * the resulting paths.
 */
function normalizeFolderSelection(
  selection: File[],
): Array<{ path: string; file: File }> {
  const named = selection
    .map((file) => ({
      file,
      path: (
        (file as { webkitRelativePath?: string }).webkitRelativePath ||
        file.name
      ).replace(/\\/g, "/"),
    }))
    .filter((entry) => !FOLDER_JUNK.test(entry.path));

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
  return pending;
}

/**
 * Lazy `PluginFileSource` over a folder selection. `list()` reports
 * browser-provided metadata only (`File.size`, no content), so the shared
 * parser's phase-1 validation — entry count, per-file and total size caps,
 * path safety — rejects an oversized or malicious selection BEFORE a single
 * byte is read. `readBytes` enforces `maxBytes` from metadata pre-read and
 * against actual bytes post-read (the `PluginFileSource` contract: throw,
 * never truncate).
 */
export function createFolderPluginFileSource(
  selection: File[],
): PluginFileSource {
  const pending = normalizeFolderSelection(selection);
  const byPath = new Map(pending.map((entry) => [entry.path, entry.file]));
  return {
    list: async () =>
      pending.map((entry) => ({
        path: entry.path,
        size: entry.file.size,
        kind: "file" as const,
      })),
    readBytes: async (path: string, maxBytes: number) => {
      const file = byPath.get(path);
      if (file === undefined) {
        throw new Error(`no such selected file: ${path}`);
      }
      if (file.size > maxBytes) {
        throw new Error(
          `selected file ${path} exceeds the ${maxBytes}-byte read limit`,
        );
      }
      const bytes = await readFileBytes(file);
      if (bytes.byteLength > maxBytes) {
        throw new Error(
          `selected file ${path} exceeds the ${maxBytes}-byte read limit`,
        );
      }
      return bytes;
    },
  };
}

/**
 * Preflight a folder selection with the shared SDK parser (the same parser
 * the backend inspect action runs). Limit and path violations reject before
 * any file content is read; success yields the content-defined `bundleHash`
 * the backend will recompute on the uploaded ZIP.
 */
export async function parsePluginBundleFromFolderSelection(
  selection: File[],
  options?: ParsePluginBundleOptions,
): Promise<ParsedPluginBundle> {
  return parsePluginBundle(createFolderPluginFileSource(selection), options);
}

/**
 * Full folder import preflight: validate + hash via the shared parser, then
 * (only for a valid bundle) read the files and build the uploadable ZIP.
 * Because the ZIP is built from exactly the validated entries, its backend
 * inspection sees the same facts the client preflight judged.
 */
export async function folderSelectionToPluginZip(
  selection: File[],
  options?: ParsePluginBundleOptions,
): Promise<{ parsed: ParsedPluginBundle; zipBytes: Uint8Array }> {
  const source = createFolderPluginFileSource(selection);
  const parsed = await parsePluginBundle(source, options);
  const limits = resolveLimits(options);
  const files: PluginBundleFile[] = [];
  for (const entry of await source.list()) {
    files.push({
      path: entry.path,
      bytes: await source.readBytes(entry.path, limits.maxFileBytes),
    });
  }
  return { parsed, zipBytes: await buildPluginZip(files) };
}

// ---------------------------------------------------------------------------
// In-memory source (already-loaded content: tests, pasted files).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ZIP building (upload path).
// ---------------------------------------------------------------------------

/** Fixed entry timestamp so repeated zips of the same folder are stable. */
const ZIP_EPOCH = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

/**
 * Build an uploadable ZIP from bundle files. Entries are sorted by
 * code-point path order with a fixed timestamp, so zipping the same folder
 * twice yields the same archive on the same machine. (Byte-identical ZIPs
 * are NOT required for hash equality — the bundle hash is computed from
 * entry contents, not archive bytes.)
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
      // File records only: implicit directory records would count against
      // the backend's archive record limit, and the folder preflight's entry
      // count assumes the upload contains exactly its files.
      createFolders: false,
    });
  }
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

// ---------------------------------------------------------------------------
// CLIENT-ONLY ARCHIVE SCREEN.
//
// Everything in this block exists because of a structural jszip gap or a
// renderer-memory concern the shared (pure, source-agnostic) SDK parser
// cannot cover. It deliberately mirrors the backend's Node archive adapter
// (mcpjam-backend convex/lib/pluginArchive.ts + pluginArchiveLimits.ts),
// which owns the same archive-level concerns on top of the same SDK parser:
//
// 1. RAW EOCD RECORD COUNT — jszip's `files` is a name-keyed object, so
//    duplicate (and same-sanitizing) names collapse during `loadAsync` and
//    the parser can never see the true record count. The backend rejects on
//    the end-of-central-directory count (`zip.entryCount`,
//    ARCHIVE_TOO_MANY_ENTRIES); the client reads the same field from the
//    raw bytes. The ZIP64 0xFFFF sentinel is rejected outright rather than
//    parsing ZIP64 structures — which is also why a configured `maxEntries`
//    must stay below 0xFFFF (validated at the API boundary): at or above
//    the sentinel the 16-bit field can no longer represent the real count.
//    The scan tolerates trailing bytes after the EOCD, because jszip does
//    (a stricter scan would fail OPEN: junk-suffixed archives would skip
//    this screen while still loading). Residual: under that tolerance a
//    forged signature inside entry data could shadow-count, but the
//    backward scan prefers the real (outermost) EOCD and the backend's
//    yauzl count stays authoritative.
// 2. COLLAPSED-DUPLICATE DETECTION — when the raw record count exceeds
//    jszip's deduplicated entry count, duplicate/colliding names were
//    silently merged last-wins; surfaced as PATH_DUPLICATE, the same code
//    the SDK parser emits for duplicate normalized paths it CAN see.
// 3. BACKSLASH ENTRY NAMES — yauzl (the backend's reader) rejects any entry
//    name containing "\" before the SDK parser ever runs, while the SDK
//    normalizes "\" to "/". Mirrored here (PATH_INVALID_CHARACTER) so a
//    backslash-named archive cannot pass client preflight and then fail
//    backend inspection.
// 4. ENCRYPTED ENTRIES — jszip cannot read them and throws while parsing
//    the central directory; mapped to FILE_UNREADABLE (the SDK has no
//    encryption code — it is an archive-level concern; the backend rejects
//    with its archive-level ARCHIVE_ENCRYPTED_ENTRY). Either way the
//    archive is rejected on both sides.
// 5. BOUNDED STREAMING INFLATION — `readBytes` inflates via jszip's
//    internalStream with a running byte counter capped at
//    min(maxBytes, declared size), aborting mid-entry the moment the cap is
//    crossed (a forged declared size cannot balloon renderer memory).
//    Mirrors the backend's `readEntryBytes` cap exactly; on both sides an
//    overrun surfaces through the shared parser as FILE_UNREADABLE.
//
// NOT mirrored, with reasons:
// - Compressed-size cap (25 MB): enforced by `assertPluginBundleWithinCap`
//   before upload (lib/plugins/plugin-api.ts), same constant as the backend.
// - Single-entry ratio-bomb heuristic (ARCHIVE_ZIP_BOMB): can never fire
//   without FILE_TOO_LARGE also firing, because its trigger floor equals
//   the SDK's per-file cap (10 MB); the SDK check covers it.
// - Raw names of DIRECTORY records: jszip preserves `unsafeOriginalName`
//   for file records only, so a crafted traversal-named directory record
//   (no content) reaches the parser with its sanitized name. Recovering the
//   raw name would require walking the central directory ourselves, which
//   preflight deliberately does not do — the backend (yauzl validates every
//   raw name) stays authoritative and rejects such an archive at import.
// ---------------------------------------------------------------------------

/**
 * Read the total-record count from the ZIP's end-of-central-directory (EOCD)
 * record — the same field the backend's yauzl adapter rejects on — directly
 * from the raw bytes, before jszip parses (and name-deduplicates) anything.
 *
 * The EOCD (`PK\x05\x06`) is 22 bytes plus an up-to-65535-byte trailing
 * comment, scanned backward within the last 65557 bytes. TOLERANCE MUST
 * MATCH THE PARSER BEING GUARDED: jszip's loader accepts trailing bytes
 * after the EOCD (it only warns), so requiring the comment to span exactly
 * to EOF would fail OPEN — a valid archive plus one appended junk byte
 * would skip this screen entirely while `loadAsync` still succeeds. A
 * candidate therefore only needs its comment length to FIT in the remaining
 * bytes; the backward scan picks the LAST (outermost) such signature. A
 * forged signature inside entry data could in principle shadow-count under
 * this tolerance, but it sits before the real EOCD so the backward scan
 * prefers the real one, and the backend's yauzl count stays authoritative
 * regardless. Returns `undefined` only when no plausible EOCD exists (jszip
 * then fails `loadAsync` on its own).
 */
function readEocdTotalEntries(bytes: Uint8Array): number | undefined {
  const EOCD_SIZE = 22;
  if (bytes.length < EOCD_SIZE) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowest = Math.max(0, bytes.length - (EOCD_SIZE + 0xffff));
  for (let i = bytes.length - EOCD_SIZE; i >= lowest; i--) {
    if (view.getUint32(i, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(i + 20, true);
    if (commentLength > bytes.length - (i + EOCD_SIZE)) continue;
    // Offset 10: total central-directory records across all disks.
    return view.getUint16(i + 10, true);
  }
  return undefined;
}

// Unix file-type bits carried in the high 16 bits of externalFileAttributes
// (mirrors the backend adapter's constants). ZIP has no real hard link; any
// populated non-regular, non-directory type is surfaced as a link kind so
// the SDK parser rejects it (PATH_LINK_ENTRY), exactly as the backend
// rejects the same records (ARCHIVE_LINK_ENTRY).
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

function entryKind(
  rawName: string,
  unixPermissions: number | string | null,
): NonNullable<PluginFileEntry["kind"]> {
  if (rawName.endsWith("/")) return "directory";
  const mode =
    typeof unixPermissions === "number"
      ? unixPermissions
      : typeof unixPermissions === "string"
        ? Number.parseInt(unixPermissions, 8)
        : null;
  if (mode !== null && Number.isFinite(mode)) {
    const type = mode & S_IFMT;
    if (type === S_IFLNK) return "symlink";
    // Some writers leave the type bits unset (0); treat those as files.
    if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) return "symlink";
  }
  return "file";
}

/** Minimal surface of jszip's (untyped) per-entry facts + internal stream. */
interface JsZipEntryInternals {
  name: string;
  dir: boolean;
  unsafeOriginalName?: string;
  unixPermissions: number | string | null;
  _data?: { uncompressedSize?: unknown };
  internalStream(type: "uint8array"): JsZipInternalStream;
}

interface JsZipInternalStream {
  on(event: "data", cb: (chunk: Uint8Array) => void): JsZipInternalStream;
  on(event: "end", cb: () => void): JsZipInternalStream;
  on(event: "error", cb: (err: Error) => void): JsZipInternalStream;
  resume(): JsZipInternalStream;
  pause(): JsZipInternalStream;
}

/**
 * jszip keeps the central-directory uncompressed size on an internal field.
 * Returns `undefined` when the internal is unavailable — callers must fall
 * back to their own hard cap, NOT zero: a zero cap would abort every
 * legitimate read if a future jszip stops populating `_data`.
 */
function declaredUncompressedSize(
  entry: JsZipEntryInternals,
): number | undefined {
  const size = entry._data?.uncompressedSize;
  return typeof size === "number" && size >= 0 ? size : undefined;
}

/**
 * Inflate one entry as a bounded stream, capped at
 * min(maxBytes, declared size) — the same cap as the backend's
 * `readEntryBytes`. Declared sizes are attacker-controlled, so the counter
 * runs on ACTUAL inflated bytes and aborts mid-entry; the remainder is never
 * inflated. Overruns throw and surface through the shared parser as
 * FILE_UNREADABLE (identical to the backend read path).
 */
function readEntryBounded(
  entry: JsZipEntryInternals,
  rawName: string,
  maxBytes: number,
): Promise<Uint8Array> {
  // When the declared size is unavailable, fall back to the hard cap —
  // never 0, which would abort every legitimate read.
  const cap = Math.min(maxBytes, declaredUncompressedSize(entry) ?? maxBytes);
  return new Promise<Uint8Array>((resolve, reject) => {
    const stream = entry.internalStream("uint8array");
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
        if (received > cap) {
          abort(
            new Error(
              `entry ${rawName} exceeded its ${cap}-byte read cap during extraction`,
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
 * Lazy `PluginFileSource` over ZIP bytes — the browser twin of the backend's
 * `createZipPluginSource` (yauzl). Runs the client-only archive screen at
 * construction, then surfaces RAW entry facts (`unsafeOriginalName`, unix
 * link kind, declared sizes) for the shared parser to judge; content is
 * inflated on demand through the bounded stream.
 */
export async function createZipPluginFileSource(
  zipBytes: Uint8Array,
  options?: ParsePluginBundleOptions,
): Promise<PluginFileSource> {
  const limits = resolveLimits(options);
  if (limits.maxEntries >= 0xffff) {
    // See the client-only screen notes: the 16-bit EOCD field saturates at
    // 0xFFFF (ZIP64 sentinel), so a cap at or above it is unenforceable
    // without parsing ZIP64 structures — which preflight deliberately
    // rejects instead.
    throw new Error(
      `maxEntries must be below 65535 (ZIP64 sentinel); got ${limits.maxEntries}`,
    );
  }

  const recordCount = readEocdTotalEntries(zipBytes);
  if (recordCount !== undefined) {
    if (recordCount === 0xffff) {
      throw issueError(
        "BUNDLE_TOO_MANY_ENTRIES",
        `archive declares 65535+ records (ZIP64); the limit is ${limits.maxEntries}`,
      );
    }
    if (recordCount > limits.maxEntries) {
      throw issueError(
        "BUNDLE_TOO_MANY_ENTRIES",
        `archive has ${recordCount} records; the limit is ${limits.maxEntries}`,
      );
    }
  }

  const { default: JSZip } = await import("jszip");
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
  try {
    zip = await JSZip.loadAsync(toZipInput(zipBytes));
  } catch (error) {
    if (error instanceof Error && /encrypted/i.test(error.message)) {
      throw issueError(
        "FILE_UNREADABLE",
        "archive contains encrypted entries, which are not supported",
      );
    }
    throw error;
  }

  const records = Object.values(zip.files) as unknown as JsZipEntryInternals[];
  if (recordCount !== undefined && recordCount > records.length) {
    throw issueError(
      "PATH_DUPLICATE",
      `archive contains ${recordCount - records.length} duplicate or colliding entry name(s)`,
    );
  }

  const entries: PluginFileEntry[] = [];
  const byRawName = new Map<string, JsZipEntryInternals>();
  for (const record of records) {
    const rawName = record.unsafeOriginalName ?? record.name;
    if (rawName.includes("\\")) {
      throw issueError(
        "PATH_INVALID_CHARACTER",
        `entry name contains "\\", which the archive reader rejects`,
        rawName,
      );
    }
    const kind = entryKind(rawName, record.unixPermissions);
    entries.push({
      path: rawName,
      size: kind === "file" ? (declaredUncompressedSize(record) ?? 0) : 0,
      kind,
    });
    if (kind !== "directory") {
      byRawName.set(rawName, record);
    }
  }

  return {
    list: async () => entries,
    readBytes: async (path: string, maxBytes: number) => {
      const record = byRawName.get(path);
      if (record === undefined) {
        throw new Error(`no such archive entry: ${path}`);
      }
      return readEntryBounded(record, path, maxBytes);
    },
  };
}

/**
 * Preflight ZIP bytes with the shared SDK parser over the raw-facts source
 * above. The verdict (and `bundleHash`) matches what the backend inspect
 * action computes on the same bytes: shared parser + equivalent archive
 * screen.
 */
export async function parsePluginBundleFromZip(
  zipBytes: Uint8Array,
  options?: ParsePluginBundleOptions,
): Promise<ParsedPluginBundle> {
  return parsePluginBundle(
    await createZipPluginFileSource(zipBytes, options),
    options,
  );
}
