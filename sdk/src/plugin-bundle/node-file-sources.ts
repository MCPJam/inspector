/**
 * The Node `PluginFileSource` adapters: a directory on disk, and a ZIP in
 * memory.
 *
 * The SDK parser (`plugin-bundle/parse.ts`) is filesystem- and
 * archive-library-free ON PURPOSE: every consumer supplies its own source
 * adapter and gets byte-identical normalization, validation and hashing.
 * These are the two adapters every Node consumer needs — the extracted
 * directory and the ZIP an import just produced.
 *
 * WHY THEY MOVED HERE FROM THE INSPECTOR SERVER. The CLI's local package modes
 * need exactly these two, and the alternatives were both bad: import them from
 * the inspector server (a CLI depending on a web server) or write a second
 * copy (two implementations of the archive rules the OpenAI package lane
 * grades, which is the "mirror the SDK" mistake this codebase has made once
 * already). The server now re-exports from here, so there is one
 * implementation and one place a rule can change.
 *
 * NODE ENTRY ONLY. This is the only module under `plugin-bundle/` that touches
 * `node:fs` or an archive library, and it is deliberately absent from
 * `plugin-bundle/index.ts` and from `browser.ts` — the parser's freedom from
 * both is what lets a browser validate a dropped package in the page, and a
 * re-export from the pure barrel would quietly end that.
 *
 * Both adapters enforce `maxBytes` by THROWING rather than truncating: a
 * truncated read would hash to something the parser would happily accept as a
 * different-but-valid bundle, which is precisely the confusion hash
 * verification exists to prevent.
 */
import { lstat, open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import JSZip from "jszip";
import type { PluginFileEntry, PluginFileSource } from "./types.js";
import type { OpenAIArchiveObservations } from "../openai-readiness/package/reader.js";

/**
 * Scratch directories a materializer writes beside the bundle it is extracting.
 *
 * Skipped rather than surfaced: they are the extractor's own bookkeeping, and
 * a parser that saw them would report them as unexpected bundle content.
 */
const IGNORED_DIR_PREFIX = ".mcpjam-tmp-";

function toBundlePath(root: string, absolute: string): string {
  // The parser's contract is POSIX-style bundle-relative paths; on Windows the
  // relative path arrives with backslashes.
  return relative(root, absolute).split(sep).join("/");
}

async function listDirectory(
  root: string,
  current: string,
  out: PluginFileEntry[],
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
export function createDirectoryPluginFileSource(
  root: string,
): PluginFileSource {
  return {
    async list() {
      const out: PluginFileEntry[] = [];
      await listDirectory(root, root, out);
      return out;
    },
    /**
     * Read one file, and ONLY a file inside the bundle.
     *
     * `path` comes from a bundle's own entry table, which on the archive side
     * is attacker-controlled: a manifest naming `../../../etc/passwd` would
     * otherwise be read and hashed as bundle content. `resolve` collapses the
     * traversal and the prefix check refuses whatever escapes.
     *
     * THE READ IS `O_NOFOLLOW` for a second reason, and it is the subtler one:
     * `lstat` measures a SYMLINK while `readFile` follows it, so a link's own
     * few bytes sail past the `maxBytes` gate and arbitrary host content comes
     * back. Opening the handle first makes the size check and the read describe
     * the same file, and a link fails to open at all — which is the right
     * outcome, because the parser rejects link entries anyway.
     */
    async readBytes(path: string, maxBytes: number) {
      const rootResolved = resolve(root);
      const absolute = resolve(rootResolved, path);
      if (
        absolute !== rootResolved &&
        !absolute.startsWith(rootResolved + sep)
      ) {
        throw new Error(`Bundle file "${path}" escapes the bundle root`);
      }

      const handle = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stats = await handle.stat();
        if (stats.size > maxBytes) {
          throw new Error(
            `Bundle file "${path}" is ${stats.size} bytes, over the ${maxBytes} byte limit`,
          );
        }
        const buffer = await handle.readFile();
        return new Uint8Array(buffer);
      } finally {
        await handle.close();
      }
    },
  };
}

/**
 * Read a plugin ZIP already in memory — the archive a desktop folder import
 * produced (`client/src/lib/plugins/folder-bundle.ts`) and posted to the local
 * materialize route.
 */
export async function createZipPluginFileSource(
  bytes: Uint8Array,
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
          // A directory has no content, so 0 is a fact. For a FILE, an absent
          // declaration is unknown rather than empty — but `size` is a
          // required number, so the only honest fallback is the limit-free 0
          // the parser already treats as "measure it yourself when you read
          // it". `readBytes` is what actually bounds the read.
          size: entry.dir ? 0 : (declaredUncompressedSize(entry) ?? 0),
          kind: entry.dir ? "directory" : "file",
        });
      });
      return out;
    },
    /**
     * Read one entry under a HARD output ceiling.
     *
     * A zip bomb is a few kilobytes on disk that inflate to gigabytes in the
     * heap. Two things have to be true to survive one, and only the second is
     * load-bearing:
     *
     *   1. The central directory's declared uncompressed size is checked
     *      first, because it is free and refuses the obvious case before a
     *      single byte is inflated.
     *   2. The inflation itself is STREAMED and counted, and aborts on the
     *      first chunk that crosses `maxBytes`.
     *
     * Step 1 alone is not a guard: it reads a private JSZip field that a
     * version bump can rename, and it trusts a number the archive supplies
     * about itself — an archive that lies is exactly the archive this is for.
     * `entry.async()` would accumulate the whole output before anyone could
     * measure it, so the check would arrive after the damage.
     *
     * Deliberately NOT failing closed when the declaration is unavailable:
     * step 2 bounds memory to `maxBytes` plus one chunk regardless, and
     * refusing every archive whose private field moved would break real
     * bundles to defend against something already defended.
     */
    async readBytes(path: string, maxBytes: number) {
      const entry = zip.file(path);
      if (!entry) throw new Error(`Bundle file "${path}" is missing`);

      const declared = declaredUncompressedSize(entry);
      if (declared !== undefined && declared > maxBytes) {
        throw new Error(
          `Bundle file "${path}" declares ${declared} bytes, over the ${maxBytes} byte limit`,
        );
      }

      return await readStreamBounded(entry, path, maxBytes);
    },
  };
}

/**
 * The entry's declared uncompressed size, or `undefined` when there isn't one.
 *
 * `_data` is private to JSZip and has no public replacement. Every value that
 * is not a non-negative safe integer reads as ABSENT rather than as a size:
 * a `NaN`, a float or a value past `MAX_SAFE_INTEGER` compares unpredictably,
 * and a comparison that silently does the wrong thing is worse than no
 * comparison at all.
 */
function declaredUncompressedSize(entry: unknown): number | undefined {
  const raw = (entry as { _data?: { uncompressedSize?: unknown } })._data
    ?.uncompressedSize;
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
    ? raw
    : undefined;
}

/**
 * Inflate one entry, aborting the moment the output passes `maxBytes`.
 *
 * The stream is destroyed and the accumulated chunks are dropped on the
 * failing path, so a refused bomb costs one chunk of memory rather than
 * however much had already been inflated.
 */
async function readStreamBounded(
  entry: JSZip.JSZipObject,
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const stream = entry.nodeStream("nodebuffer");
  let chunks: Buffer[] = [];
  let total = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      // Free what was inflated before handing the error back: on a bomb this
      // is the difference between one chunk held and everything up to the
      // limit held for as long as the rejection takes to unwind.
      chunks = [];
      // JSZip types the return as `NodeJS.ReadableStream`, which declares no
      // `destroy`; the object it actually hands back is a `Readable` and does
      // have one. Pause first so the cast is belt-and-braces rather than the
      // only thing stopping the inflation.
      stream.pause();
      try {
        (stream as { destroy?: () => void }).destroy?.();
      } catch {
        // A stream that cannot be destroyed still stops mattering once it is
        // paused, its chunks are dropped, and nothing reads it again.
      }
      reject(error);
    };

    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(
          new Error(
            `Bundle file "${path}" exceeds the ${maxBytes} byte limit`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", (error: Error) => fail(error));
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });

  return new Uint8Array(Buffer.concat(chunks, total));
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
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIZE = 22;
const CENTRAL_FILE_HEADER_SIZE = 46;
const ZIP64_ENTRY_COUNT_SENTINEL = 0xffff;
const ZIP64_OFFSET_SENTINEL = 0xffffffff;

/**
 * Entry names exactly as the central directory records them.
 *
 * WHY NOT `Object.keys(zip.files)`, which is what this used to be. JSZip
 * normalizes while it loads: it resolves `.` and `..`, collapses doubled
 * separators, and — because `files` is a name-keyed object — silently keeps
 * only the LAST of two entries recording the same name. Those are three of the
 * exact conditions the portal rejects, so the rules were being checked against
 * a table with the violations already repaired out of it. Worse than a missed
 * check: the reader treats an absent `rawEntryNames` as "not observed" and a
 * present one as "checked", so the repaired list reported a clean archive
 * rather than an unexamined one.
 *
 * Reading the directory directly also survives an encrypted archive, whose
 * central directory is plaintext even when every entry body is not.
 *
 * Returns `undefined` — not `[]` — for anything this cannot read faithfully
 * (no EOCD, a ZIP64 sentinel, a truncated or non-conforming directory), so the
 * gap stays visible instead of becoming an empty list that reads as "checked,
 * nothing found".
 */
function readRawCentralDirectoryNames(bytes: Uint8Array): string[] | undefined {
  if (bytes.byteLength < EOCD_SIZE) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8");

  // Backward scan, so a zip carrying another zip's bytes in its payload finds
  // the real (outermost) EOCD first — the same preference the client screen
  // documents.
  const lowest = Math.max(0, bytes.byteLength - (EOCD_SIZE + 0xffff));
  for (let start = bytes.byteLength - EOCD_SIZE; start >= lowest; start -= 1) {
    if (view.getUint32(start, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(start + 20, true);
    if (commentLength > bytes.byteLength - (start + EOCD_SIZE)) continue;

    const totalEntries = view.getUint16(start + 10, true);
    const directoryOffset = view.getUint32(start + 16, true);
    if (
      totalEntries === ZIP64_ENTRY_COUNT_SENTINEL ||
      directoryOffset === ZIP64_OFFSET_SENTINEL
    ) {
      return undefined;
    }

    const names: string[] = [];
    let cursor = directoryOffset;
    for (let entry = 0; entry < totalEntries; entry += 1) {
      if (cursor + CENTRAL_FILE_HEADER_SIZE > bytes.byteLength)
        return undefined;
      if (view.getUint32(cursor, true) !== CENTRAL_FILE_HEADER_SIGNATURE) {
        return undefined;
      }
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const entryCommentLength = view.getUint16(cursor + 32, true);
      const nameStart = cursor + CENTRAL_FILE_HEADER_SIZE;
      if (nameStart + nameLength > bytes.byteLength) return undefined;
      // Decoded as UTF-8 whether or not the entry sets the UTF-8 flag: a
      // CP437 name that is pure ASCII decodes identically, and every rule
      // checked against these names — separators, empty and dot segments,
      // duplicates — is decided by ASCII characters.
      names.push(
        decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      );
      cursor = nameStart + nameLength + extraLength + entryCommentLength;
    }
    return names;
  }
  return undefined;
}

export async function collectZipArchiveObservations(
  bytes: Uint8Array,
): Promise<OpenAIArchiveObservations> {
  // Read straight off the archive, BEFORE and independently of JSZip: these
  // are the names the portal will see, and the loader's job is to produce a
  // readable tree rather than to preserve them.
  const rawEntryNames = readRawCentralDirectoryNames(bytes);

  try {
    await JSZip.loadAsync(bytes);
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
    // The central directory is readable even here, so the names survive an
    // archive the loader refused.
    return { compressedBytes: bytes.byteLength, rawEntryNames };
  }
  return {
    // The uploaded bytes, which is exactly what the portal's compressed-size
    // limit is measured against.
    compressedBytes: bytes.byteLength,
    // RAW names, straight off the entry table. The readiness reader checks the
    // portal's path rules against these BEFORE anything normalizes them,
    // because normalization repairs a backslash separator and a doubled or `.`
    // segment — three of the things the portal rejects.
    rawEntryNames,
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
