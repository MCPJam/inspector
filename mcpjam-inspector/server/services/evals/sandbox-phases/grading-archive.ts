/**
 * A graded iteration's grading archive (EFTW-90): what its grading box was
 * given, kept so "Test on a past iteration" can grade a draft evaluator on
 * exactly that.
 *
 * An uncompressed POSIX tar: `iteration.json` at the root, the bytes the box
 * got as `/mcpjam/iteration.json`, and each declared file or directory at
 * `files/<its absolute path without the leading slash>`. Regular files and
 * directories only, 0644, or 0755 when executable.
 *
 * The backend keeps the archive as opaque bytes, so reading it back applies
 * the rules a fresh copy out of the agent's box gets (`grading-files.ts`):
 * byte caps, no links, no `..`, and only paths under a root the run declared.
 */
import { Header, Pax, type HeaderData } from "tar";
import { logger } from "../../../utils/logger.js";
import { isUsableStorageDestination } from "../../../utils/storage-destination.js";
import {
  archiveRoot,
  MAX_GRADING_FILE_ENTRIES,
  MAX_GRADING_FILES_BYTES,
  parseGradingArchive,
  readCappedBytes,
  type GradingFileEntry,
} from "./grading-files.js";
import type { GradingBoxInput } from "./iteration-phases.js";

/** The most the backend stores for one iteration. */
export const MAX_GRADING_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** How long reading a stored archive back may take. */
export const GRADING_ARCHIVE_FETCH_TIMEOUT_MS = 30_000;

const ITERATION_JSON = "iteration.json";
const FILES_DIR = "files";
const BLOCK = 512;
/** A fixed time, so one input always packs to the same bytes. */
const EPOCH = new Date(0);

const FETCH_FAILED =
  "Couldn't load the stored grading files for this iteration. Try the test again.";
const TOO_LARGE =
  "Couldn't use the stored grading files for this iteration because they are over 64 MB.";
const UNREADABLE = "Couldn't read the stored grading files for this iteration.";

/** One entry's header blocks: a pax header first when its path needs one. */
function headerBlocks(data: HeaderData): Uint8Array[] {
  const header = new Header(data);
  const needsPax = header.encode();
  if (!header.block) throw new Error("A tar header could not be written.");
  return needsPax
    ? [new Pax({ path: data.path }).encode(), header.block]
    : [header.block];
}

function entryParts(entry: GradingFileEntry): Uint8Array[] {
  const path = `${FILES_DIR}/${entry.path}`;
  if (entry.type === "directory") {
    return headerBlocks({
      path: `${path}/`,
      mode: 0o755,
      size: 0,
      mtime: EPOCH,
      type: "Directory",
    });
  }
  return fileParts(path, entry.data, entry.executable);
}

function fileParts(
  path: string,
  data: Uint8Array,
  executable: boolean,
): Uint8Array[] {
  return [
    ...headerBlocks({
      path,
      mode: executable ? 0o755 : 0o644,
      size: data.byteLength,
      mtime: EPOCH,
      type: "File",
    }),
    data,
    new Uint8Array((BLOCK - (data.byteLength % BLOCK)) % BLOCK),
  ];
}

/**
 * Pack what a grading box was given. `undefined` when the archive would be
 * over {@link MAX_GRADING_ARCHIVE_BYTES}: the iteration then keeps none.
 */
export function buildGradingArchive(
  input: GradingBoxInput,
): Uint8Array<ArrayBuffer> | undefined {
  const parts: Uint8Array[] = [];
  let size = 0;
  const add = (more: Uint8Array[]) => {
    for (const part of more) {
      parts.push(part);
      size += part.byteLength;
    }
    return size <= MAX_GRADING_ARCHIVE_BYTES;
  };
  const json = new TextEncoder().encode(input.iterationJson);
  if (!add(fileParts(ITERATION_JSON, json, false))) return undefined;
  for (const entry of input.files) {
    if (!add(entryParts(entry))) return undefined;
  }
  // The end of the archive: two zero blocks.
  if (!add([new Uint8Array(2 * BLOCK)])) return undefined;
  const archive = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    archive.set(part, offset);
    offset += part.byteLength;
  }
  return archive;
}

export type StoredGradingInput =
  { ok: true; input: GradingBoxInput } | { ok: false; problem: string };

/** The archive's `iteration.json`, when it is UTF-8 JSON holding an object. */
function readIterationJson(data: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? text
      : undefined;
  } catch {
    // Not UTF-8, or not JSON: the archive is not one this server wrote.
    return undefined;
  }
}

function unreadable(reason: string): StoredGradingInput {
  logger.warn("[evals] refused a stored grading archive", { reason });
  return { ok: false, problem: UNREADABLE };
}

/**
 * Read a stored archive back into what a grading box is given. `declared` is
 * the run's frozen `grading.files`: an entry outside them is dropped, as it
 * would be when copied out of the agent's box.
 */
export async function readGradingArchive(
  archive: Uint8Array,
  declared: readonly string[],
): Promise<StoredGradingInput> {
  const fileRoots = declared
    .map(archiveRoot)
    .filter(Boolean)
    .map((root) => `${FILES_DIR}/${root}`);
  const parsed = await parseGradingArchive(
    archive,
    [ITERATION_JSON, ...fileRoots],
    { bytes: MAX_GRADING_ARCHIVE_BYTES, entries: MAX_GRADING_FILE_ENTRIES + 1 },
  );
  if (!parsed.ok) return unreadable(parsed.problem);
  let iterationJson: string | undefined;
  const files: GradingFileEntry[] = [];
  let fileBytes = 0;
  for (const entry of parsed.entries) {
    if (
      entry.path === ITERATION_JSON &&
      entry.type === "file" &&
      iterationJson === undefined
    ) {
      iterationJson = readIterationJson(entry.data);
      if (iterationJson === undefined) return unreadable("iteration.json");
      continue;
    }
    // A second iteration.json, or anything under one, is not this layout.
    if (!entry.path.startsWith(`${FILES_DIR}/`)) {
      return unreadable("an entry outside files/");
    }
    const path = entry.path.slice(FILES_DIR.length + 1);
    if (entry.type === "directory") {
      files.push({ type: "directory", path });
      continue;
    }
    fileBytes += entry.data.byteLength;
    files.push({ ...entry, path });
  }
  if (iterationJson === undefined) return unreadable("no iteration.json");
  // The run's own caps: an archive a run wrote never exceeds them.
  if (
    fileBytes > MAX_GRADING_FILES_BYTES ||
    files.length > MAX_GRADING_FILE_ENTRIES
  ) {
    return unreadable("over the declared files' caps");
  }
  return { ok: true, input: { iterationJson, files } };
}

/**
 * Fetch a stored archive from the storage URL the backend named, within
 * {@link MAX_GRADING_ARCHIVE_BYTES} and {@link GRADING_ARCHIVE_FETCH_TIMEOUT_MS}.
 * The URL is read here only and never passed on.
 */
export async function fetchGradingArchive(
  source: { url: string; bytes: number },
  signal?: AbortSignal,
): Promise<{ ok: true; archive: Uint8Array } | { ok: false; problem: string }> {
  if (source.bytes > MAX_GRADING_ARCHIVE_BYTES) {
    return { ok: false, problem: TOO_LARGE };
  }
  if (!isUsableStorageDestination(source.url)) {
    logger.warn("[evals] stored grading archive has an unusable address");
    return { ok: false, problem: FETCH_FAILED };
  }
  try {
    const timeout = AbortSignal.timeout(GRADING_ARCHIVE_FETCH_TIMEOUT_MS);
    const response = await fetch(source.url, {
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok || !response.body) {
      logger.warn("[evals] couldn't fetch a stored grading archive", {
        status: response.status,
      });
      return { ok: false, problem: FETCH_FAILED };
    }
    const archive = await readCappedBytes(
      response.body,
      MAX_GRADING_ARCHIVE_BYTES,
    );
    return archive ? { ok: true, archive } : { ok: false, problem: TOO_LARGE };
  } catch (error) {
    logger.warn("[evals] couldn't fetch a stored grading archive", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, problem: FETCH_FAILED };
  }
}
