/**
 * A harness session snapshot as bytes: the session files as gzipped JSON.
 * Reading and writing the box goes through the turn's own file-capable sandbox
 * session. Compression runs off the event loop: the server is shared.
 */
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { SecretScrubber } from "../../secrets/secret-scrubber.js";
import {
  isPathUnderRoot,
  parseFileListing,
  type SessionFileSpec,
} from "./session-files.js";

/** The slice of the turn's sandbox session a snapshot needs. */
export type SnapshotFileSession = {
  readTextFile(args: {
    path: string;
    abortSignal?: AbortSignal;
  }): PromiseLike<string | null>;
  writeTextFile(args: { path: string; content: string }): PromiseLike<unknown>;
  run(args: {
    command: string;
    abortSignal?: AbortSignal;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
};

export type SnapshotBundle = {
  version: 1;
  harnessId: SessionFileSpec["harnessId"];
  harnessSessionId: string;
  /** The CLI's working folder when saved; Claude Code files its transcript by it. */
  workDir?: string;
  files: Array<{ path: string; content: string }>;
};

/** More than any real session holds; a larger one is not saved. */
export const MAX_SNAPSHOT_FILES = 500;
export const MAX_SNAPSHOT_RAW_BYTES = 32 * 1024 * 1024;
/** What a restore inflates at most: the raw limit plus room for escaping. */
const MAX_DECODED_BYTES = MAX_SNAPSHOT_RAW_BYTES * 2;
const READ_CONCURRENCY = 8;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export class SnapshotTooLargeError extends Error {}

/** The box's home, as its shell reports it. */
export async function boxHome(
  session: SnapshotFileSession,
  abortSignal?: AbortSignal,
): Promise<string> {
  const res = await session.run({
    command: 'printf %s "$HOME"',
    ...(abortSignal ? { abortSignal } : {}),
  });
  return res.stdout.trim();
}

/**
 * Read the spec's files off the box within the size limits. `scrubbed` says a
 * delivered secret was found in them; the files come back unchanged either way.
 */
export async function collectSessionFiles(args: {
  session: SnapshotFileSession;
  spec: SessionFileSpec;
  home: string;
  scrubber: SecretScrubber | null;
  abortSignal?: AbortSignal;
}): Promise<{ files: SnapshotBundle["files"]; scrubbed: boolean }> {
  const { session, spec, home } = args;
  const listing = await session.run({
    command: spec.listCommand,
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
  });
  // A listing that failed after printing some paths would save part of a
  // session; one that printed nothing (no session folder yet) saves nothing.
  if (listing.exitCode !== 0 && listing.stdout.trim()) {
    throw new Error(`session file listing failed (exit ${listing.exitCode})`);
  }
  const listed = parseFileListing(listing.stdout, home, spec.root);
  const total = listed.reduce((sum, file) => sum + file.bytes, 0);
  if (listed.length > MAX_SNAPSHOT_FILES || total > MAX_SNAPSHOT_RAW_BYTES) {
    throw new SnapshotTooLargeError(
      `session has ${listed.length} files, ${total} bytes`,
    );
  }
  const files: SnapshotBundle["files"] = [];
  let scrubbed = false;
  for (let i = 0; i < listed.length; i += READ_CONCURRENCY) {
    const batch = listed.slice(i, i + READ_CONCURRENCY);
    const contents = await Promise.all(
      batch.map((file) =>
        session.readTextFile({
          path: `${home}/${file.path}`,
          ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
        }),
      ),
    );
    batch.forEach((file, index) => {
      const content = contents[index];
      // Gone since the listing: the CLI rotated it. Nothing to keep.
      if (content == null) return;
      const complete = completeLines(file.path, content);
      if (args.scrubber && args.scrubber.scrubString(complete) !== complete) {
        scrubbed = true;
      }
      files.push({ path: file.path, content: complete });
    });
  }
  return { files, scrubbed };
}

/**
 * A transcript up to its last whole line. The next turn may already be
 * appending when a save reads it, and a resume would choke on half a record.
 */
function completeLines(path: string, content: string): string {
  if (!path.endsWith(".jsonl") || content.endsWith("\n")) return content;
  const cut = content.lastIndexOf("\n") + 1;
  try {
    // A whole final record without its newline is still a record.
    JSON.parse(content.slice(cut));
    return content;
  } catch {
    // Half a record: the writer is mid-append.
    return content.slice(0, cut);
  }
}

export async function encodeSnapshot(
  bundle: SnapshotBundle,
): Promise<Uint8Array<ArrayBuffer>> {
  const json = Buffer.from(JSON.stringify(bundle), "utf8");
  // JSON escaping can grow text past what a restore will inflate.
  if (json.byteLength > MAX_DECODED_BYTES) {
    throw new SnapshotTooLargeError("snapshot JSON exceeds the decode limit");
  }
  return new Uint8Array(await gzipAsync(json));
}

/**
 * Parse a downloaded snapshot. Refuses one for another session or runtime, or
 * with any path outside the spec's root, rather than writing part of it.
 */
export async function decodeSnapshot(
  bytes: Uint8Array,
  expected: { spec: SessionFileSpec; home: string; harnessSessionId: string },
): Promise<SnapshotBundle> {
  const json = await gunzipAsync(bytes, { maxOutputLength: MAX_DECODED_BYTES });
  const parsed: unknown = JSON.parse(json.toString("utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("snapshot is not an object");
  }
  const bundle = parsed as Partial<SnapshotBundle>;
  if (
    bundle.version !== 1 ||
    bundle.harnessId !== expected.spec.harnessId ||
    bundle.harnessSessionId !== expected.harnessSessionId ||
    !Array.isArray(bundle.files) ||
    bundle.files.length > MAX_SNAPSHOT_FILES
  ) {
    throw new Error("snapshot does not belong to this session");
  }
  for (const file of bundle.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      typeof file.content !== "string" ||
      !isPathUnderRoot(file.path, expected.home, expected.spec.root)
    ) {
      throw new Error("snapshot names a file outside the session folder");
    }
  }
  return bundle as SnapshotBundle;
}

/** Write a decoded snapshot onto the box, creating its folders first. */
export async function writeSessionFiles(args: {
  session: SnapshotFileSession;
  home: string;
  files: SnapshotBundle["files"];
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { session, home } = args;
  const folders = [
    ...new Set(
      args.files.map((file) => `${home}/${file.path}`.replace(/\/[^/]+$/, "")),
    ),
  ];
  if (folders.length > 0) {
    // Every path passed `isPathUnderRoot`, and quoting stops word splitting.
    const res = await session.run({
      command: `mkdir -p ${folders.map((folder) => `'${folder}'`).join(" ")}`,
      ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    });
    if (res.exitCode !== 0) throw new Error("could not create session folders");
  }
  for (let i = 0; i < args.files.length; i += READ_CONCURRENCY) {
    await Promise.all(
      args.files.slice(i, i + READ_CONCURRENCY).map((file) =>
        session.writeTextFile({
          path: `${home}/${file.path}`,
          content: file.content,
        }),
      ),
    );
  }
}
