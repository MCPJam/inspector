/**
 * Files a suite declared for grading (EFTW-90, E7, amendments P6 and P7):
 * copied out of the agent's box before it is released, and into the grading
 * box before the evaluators run.
 *
 * The agent controls everything in its box, the `tar` that packs the files
 * included, so the archive is hostile input:
 *
 * - it is read with a byte cap, never trusting a size the box reports;
 * - it is rebuilt here from regular files and directories only, each inside
 *   a declared path, with no `..` and no absolute path (links, devices and
 *   fifos are dropped, as `runtime-install.ts` drops them);
 * - in the grading box the files are written through E2B's file API as the
 *   box user, never root, as 0644, or 0755 when executable: no setuid,
 *   setgid or sticky bit and no owner survives the copy.
 */
import { randomUUID } from "node:crypto";
import { Parser, type ReadEntry } from "tar";
import { shellQuote } from "../../../utils/harness/shell-quote.js";
import type { PhaseSandbox } from "./exec.js";

/** Every declared file together, uncompressed (amendment P6). */
export const MAX_GRADING_FILES_BYTES = 25 * 1024 * 1024;
/** Files and directories in one copy. */
export const MAX_GRADING_FILE_ENTRIES = 10_000;
/** The archive: the content, a header and padding per entry, and the trailer. */
const MAX_ARCHIVE_BYTES =
  MAX_GRADING_FILES_BYTES + MAX_GRADING_FILE_ENTRIES * 1024 + 10_240;

/** The grading box's scratch directory (a fresh box the agent never touched). */
const WORK_DIR = "/tmp/mcpjam";
/** Files per E2B write request. */
const WRITE_BATCH = 200;

export type GradingFileEntry =
  | { type: "directory"; path: string }
  | { type: "file"; path: string; executable: boolean; data: Uint8Array };

export type CollectedGradingFiles =
  | { ok: true; entries: GradingFileEntry[]; bytes: number }
  | { ok: false; problem: string };

/** How much one archive may hold: file content bytes, and files and folders. */
export type GradingArchiveLimits = { bytes: number; entries: number };

const DECLARED_FILE_LIMITS: GradingArchiveLimits = {
  bytes: MAX_GRADING_FILES_BYTES,
  entries: MAX_GRADING_FILE_ENTRIES,
};

const overCap = (limits: GradingArchiveLimits) =>
  `The files declared for grading are over ${limits.bytes / (1024 * 1024)} MB together.`;
const OVER_CAP = overCap(DECLARED_FILE_LIMITS);
const COMPRESSED =
  "The declared files couldn't be read: the agent's box returned a compressed archive, and only a plain tar is accepted.";
/** gzip and zstd: the formats the parser would recognize and inflate. */
const COMPRESSED_MAGIC: ReadonlyArray<readonly number[]> = [
  [0x1f, 0x8b],
  [0x28, 0xb5, 0x2f, 0xfd],
];

/** `/home/user/app/` → `home/user/app`: the archive's own spelling. */
export function archiveRoot(declared: string): string {
  return declared.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * The entry's path if it may be copied: relative, without `..` or empty
 * segments, and inside one of `roots`. `undefined` otherwise.
 */
export function admittedPath(
  raw: string,
  roots: readonly string[],
): string | undefined {
  const path = raw.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!path || path.startsWith("/")) return undefined;
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return undefined;
  }
  return roots.some((root) => path === root || path.startsWith(`${root}/`))
    ? path
    : undefined;
}

/** Read at most `limit` bytes of a stream; `undefined` when it is longer. */
export async function readCappedBytes(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array | undefined> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Rebuild the archive's admissible entries. `limits` defaults to the declared
 * files' own caps; a stored grading archive passes its larger ones.
 */
export async function parseGradingArchive(
  archive: Uint8Array,
  roots: readonly string[],
  limits: GradingArchiveLimits = DECLARED_FILE_LIMITS,
): Promise<CollectedGradingFiles> {
  // None of the declared paths existed: GNU tar writes only zero blocks,
  // which the parser calls an unrecognized archive.
  if (!archive.subarray(0, 512).some((byte) => byte !== 0)) {
    return { ok: true, entries: [], bytes: 0 };
  }
  // The pack command writes a plain tar, so a compressed one came from a
  // replaced `tar`. The parser would inflate it unasked, a few MB into
  // gigabytes, so it is refused unread.
  if (
    COMPRESSED_MAGIC.some((magic) => magic.every((b, i) => archive[i] === b))
  ) {
    return { ok: false, problem: COMPRESSED };
  }
  const entries: GradingFileEntry[] = [];
  let bytes = 0;
  let problem: string | undefined;
  // `zstd: false` and a ratio of 1 back the check above up: nothing is
  // sniffed as zstd, and a decompressor that did start would be stopped as
  // soon as it wrote more than it read.
  const parser = new Parser({
    strict: true,
    zstd: false,
    maxDecompressionRatio: 1,
  });
  // Stop at the first cap rather than read the rest of the archive.
  const stop = (message: string) => {
    problem = message;
    parser.abort(new Error(message));
  };
  const done = new Promise<void>((resolve, reject) => {
    parser.on("end", () => resolve());
    parser.on("error", (error: Error) => reject(error));
  });
  parser.on("entry", (entry: ReadEntry) => {
    const path = admittedPath(entry.path, roots);
    const type = entry.type;
    if (problem || !path || (type !== "File" && type !== "Directory")) {
      entry.resume();
      return;
    }
    if (entries.length >= limits.entries) {
      stop(
        `More than ${limits.entries.toLocaleString("en-US")} files and folders were declared for grading.`,
      );
      return;
    }
    if (type === "Directory") {
      entries.push({ type: "directory", path });
      entry.resume();
      return;
    }
    const chunks: Buffer[] = [];
    entry.on("data", (chunk: Buffer) => {
      if (problem) return;
      bytes += chunk.byteLength;
      if (bytes > limits.bytes) stop(overCap(limits));
      else chunks.push(chunk);
    });
    entry.on("end", () => {
      if (problem) return;
      entries.push({
        type: "file",
        path,
        executable: ((entry.mode ?? 0) & 0o111) !== 0,
        data: new Uint8Array(Buffer.concat(chunks)),
      });
    });
  });
  try {
    parser.end(Buffer.from(archive));
    await done;
  } catch (error) {
    // A cap stops the parser with an error of its own; report the cap.
    if (problem) return { ok: false, problem };
    return {
      ok: false,
      problem: `The declared files couldn't be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return problem ? { ok: false, problem } : { ok: true, entries, bytes };
}

/**
 * Pack the declared paths in the agent's box and bring them here. A
 * declared path that doesn't exist is skipped: the evaluator decides what a
 * missing file means.
 */
export async function collectGradingFiles(
  agentBox: PhaseSandbox,
  declared: readonly string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<CollectedGradingFiles> {
  const roots = declared.map(archiveRoot).filter(Boolean);
  if (roots.length === 0) return { ok: true, entries: [], bytes: 0 };
  // A directory with an unguessable name that `mkdir` (no `-p`) creates
  // fresh, so the agent can't have planted the archive path as a link (to
  // `/dev/stdout`, say). Output is never retained either: a `tar` the agent
  // replaced could print without end.
  const work = `/tmp/mcpjam-files-${randomUUID()}`;
  const archivePath = `${work}/files.tar`;
  const listPath = `${work}/files.list`;
  // GNU tar recurses into directories and stores links as links (no `-h`);
  // exit 1 means a file changed while it was read, which is still an archive.
  const pack = [
    `umask 077 && mkdir ${work} && cd / && : > ${listPath}`,
    `for p in ${roots.map(shellQuote).join(" ")}; do`,
    `  if [ -e "$p" ] || [ -L "$p" ]; then printf '%s\\0' "$p" >> ${listPath}; fi`,
    "done",
    `tar --create --file=${archivePath} --null --files-from=${listPath} --ignore-failed-read; s=$?`,
    'if [ "$s" -gt 1 ]; then exit "$s"; fi',
  ].join("\n");
  try {
    await agentBox.commands.run(pack, {
      timeoutMs: opts.timeoutMs,
      retainOutput: false,
      onStdout: () => {},
      onStderr: () => {},
    });
    const stream = await agentBox.files.read(archivePath, {
      format: "stream",
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const archive = await readCappedBytes(stream, MAX_ARCHIVE_BYTES);
    if (!archive) return { ok: false, problem: OVER_CAP };
    return await parseGradingArchive(archive, roots);
  } catch (error) {
    return {
      ok: false,
      problem: `The declared files couldn't be copied from the agent's box: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Write `entries` into the grading box at their original paths, as the box user. */
export async function restoreGradingFiles(
  gradingBox: PhaseSandbox,
  entries: readonly GradingFileEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const absolute = (path: string) => `/${path}`;
  const directories = entries.filter((e) => e.type === "directory");
  const files = entries.filter(
    (e): e is Extract<GradingFileEntry, { type: "file" }> => e.type === "file",
  );
  // Through lists rather than argv, so ten thousand paths fit one command.
  const lists: Array<{ path: string; data: string }> = [];
  if (directories.length) {
    lists.push({
      path: `${WORK_DIR}/grading-dirs.list`,
      data: directories.map((d) => `${absolute(d.path)}\0`).join(""),
    });
  }
  const executables = files.filter((f) => f.executable);
  if (executables.length) {
    lists.push({
      path: `${WORK_DIR}/grading-exec.list`,
      data: executables.map((f) => `${absolute(f.path)}\0`).join(""),
    });
  }
  if (lists.length) await gradingBox.files.write(lists);
  if (directories.length) {
    await gradingBox.commands.run(
      `xargs -0 -r mkdir -p -- < ${WORK_DIR}/grading-dirs.list`,
      { timeoutMs: 60_000 },
    );
  }
  for (let i = 0; i < files.length; i += WRITE_BATCH) {
    await gradingBox.files.write(
      files
        .slice(i, i + WRITE_BATCH)
        .map((f) => ({ path: absolute(f.path), data: f.data })),
    );
  }
  if (executables.length) {
    await gradingBox.commands.run(
      `xargs -0 -r chmod 0755 -- < ${WORK_DIR}/grading-exec.list`,
      { timeoutMs: 60_000 },
    );
  }
}
