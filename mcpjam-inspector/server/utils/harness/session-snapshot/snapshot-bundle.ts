/**
 * A harness session snapshot as bytes: the session files, each scrubbed of the
 * turn's materialized secrets, as gzipped JSON. Reading and writing the box
 * goes through the turn's own file-capable sandbox session.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import type { SecretScrubber } from "../../secrets/secret-scrubber.js";
import {
  isPathUnderRoot,
  parseFileListing,
  type SessionFileSpec,
} from "./session-files.js";

/** The slice of the turn's sandbox session a snapshot needs. */
export type SnapshotFileSession = {
  readTextFile(args: { path: string }): PromiseLike<string | null>;
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
export const MAX_SNAPSHOT_RAW_BYTES = 64 * 1024 * 1024;
const READ_CONCURRENCY = 8;

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

/** Read the spec's files off the box, scrubbed, within the size limits. */
export async function collectSessionFiles(args: {
  session: SnapshotFileSession;
  spec: SessionFileSpec;
  home: string;
  scrubber: SecretScrubber | null;
  abortSignal?: AbortSignal;
}): Promise<SnapshotBundle["files"]> {
  const { session, spec, home } = args;
  const listing = await session.run({
    command: spec.listCommand,
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
  });
  const listed = parseFileListing(listing.stdout, home, spec.root);
  const total = listed.reduce((sum, file) => sum + file.bytes, 0);
  if (listed.length > MAX_SNAPSHOT_FILES || total > MAX_SNAPSHOT_RAW_BYTES) {
    throw new SnapshotTooLargeError(
      `session has ${listed.length} files, ${total} bytes`,
    );
  }
  const files: SnapshotBundle["files"] = [];
  for (let i = 0; i < listed.length; i += READ_CONCURRENCY) {
    const batch = listed.slice(i, i + READ_CONCURRENCY);
    const contents = await Promise.all(
      batch.map((file) =>
        session.readTextFile({ path: `${home}/${file.path}` }),
      ),
    );
    batch.forEach((file, index) => {
      const content = contents[index];
      // Gone since the listing: the CLI rotated it. Nothing to keep.
      if (content == null) return;
      const complete = completeLines(file.path, content);
      files.push({
        path: file.path,
        content: args.scrubber ? args.scrubber.scrubString(complete) : complete,
      });
    });
  }
  return files;
}

/**
 * A transcript up to its last whole line. The next turn may already be
 * appending when a save reads it, and a resume would choke on half a record.
 */
function completeLines(path: string, content: string): string {
  if (!path.endsWith(".jsonl") || content.endsWith("\n")) return content;
  return content.slice(0, content.lastIndexOf("\n") + 1);
}

export function encodeSnapshot(bundle: SnapshotBundle): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(bundle), "utf8"));
}

/**
 * Parse a downloaded snapshot. Refuses one for another session or runtime, or
 * with any path outside the spec's root, rather than writing part of it.
 */
export function decodeSnapshot(
  bytes: Uint8Array,
  expected: { spec: SessionFileSpec; home: string; harnessSessionId: string },
): SnapshotBundle {
  const parsed: unknown = JSON.parse(
    gunzipSync(bytes, { maxOutputLength: MAX_SNAPSHOT_RAW_BYTES * 2 }).toString(
      "utf8",
    ),
  );
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
