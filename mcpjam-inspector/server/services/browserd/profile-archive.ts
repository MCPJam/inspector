/**
 * Portable Chromium profile archives.
 *
 * A profile is copied only while its browser is stopped (local) or while the
 * browserd queue is drained (hosted). The archive is deliberately a tar.gz,
 * rather than a hand-picked cookie export: Chromium stores origin data across
 * several files and the profile directory is the unit that preserves it.
 *
 * This module is also bundled into the standalone browserd artifact. Keep the
 * tar implementation self-contained so the box does not need an npm install.
 */
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const MAX_BROWSER_PROFILE_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_BROWSER_PROFILE_UNCOMPRESSED_BYTES =
  MAX_BROWSER_PROFILE_ARCHIVE_BYTES * 4;
const TAR_BLOCK_BYTES = 512;

const EXCLUDED_PROFILE_SEGMENTS = new Set([
  "cache",
  "code cache",
  "gpucache",
  "dawncache",
  "grshadercache",
  "shadercache",
  "singletonlock",
  "singletoncookie",
  "singletonsock",
]);

function isExcludedProfilePath(path: string): boolean {
  return path
    .split(/[\\/]+/)
    .some((segment) => EXCLUDED_PROFILE_SEGMENTS.has(segment.toLowerCase()));
}

function assertSafeArchivePath(path: string): void {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new Error("browser profile archive contains an unsafe path");
  }
}

function writeTarString(
  header: Buffer,
  value: string,
  offset: number,
  length: number,
): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) {
    throw new Error("browser profile path is too long for a portable archive");
  }
  bytes.copy(header, offset);
}

function writeTarOctal(
  header: Buffer,
  value: number,
  offset: number,
  length: number,
): void {
  const encoded = `${Math.max(0, value)
    .toString(8)
    .padStart(length - 1, "0")}\0`;
  if (encoded.length > length) {
    throw new Error("browser profile archive metadata is too large");
  }
  header.write(encoded, offset, length, "ascii");
}

function makeTarHeader(
  path: string,
  kind: "file" | "directory",
  size: number,
  mode: number,
): Buffer {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  assertSafeArchivePath(normalized);
  const header = Buffer.alloc(TAR_BLOCK_BYTES);

  // POSIX ustar permits a 100-byte name and a 155-byte prefix. Splitting on
  // the last slash keeps ordinary Chromium profile paths portable.
  let name = normalized;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const slash = normalized.lastIndexOf("/");
    if (slash <= 0) {
      throw new Error(
        "browser profile path is too long for a portable archive",
      );
    }
    prefix = normalized.slice(0, slash);
    name = normalized.slice(slash + 1);
    if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100) {
      throw new Error(
        "browser profile path is too long for a portable archive",
      );
    }
  }

  writeTarString(header, name, 0, 100);
  writeTarOctal(header, mode & 0o7777, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, size, 124, 12);
  writeTarOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = kind === "directory" ? 0x35 : 0x30;
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  writeTarString(header, "mcpjam", 265, 32);
  writeTarString(header, "mcpjam", 297, 32);
  writeTarString(header, prefix, 345, 155);

  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

async function collectProfileEntries(
  profileDir: string,
  currentDir: string,
  entries: Buffer[],
  uncompressedBytes: { value: number },
): Promise<void> {
  const children = await readdir(currentDir, { withFileTypes: true });
  for (const child of children) {
    const absolutePath = join(currentDir, child.name);
    const archivePath = relative(profileDir, absolutePath).split(sep).join("/");
    assertSafeArchivePath(archivePath);
    if (isExcludedProfilePath(archivePath)) continue;

    const stat = await lstat(absolutePath);
    if (stat.isDirectory()) {
      const header = makeTarHeader(archivePath, "directory", 0, stat.mode);
      entries.push(header);
      uncompressedBytes.value += header.byteLength;
      if (uncompressedBytes.value > MAX_BROWSER_PROFILE_UNCOMPRESSED_BYTES) {
        throw new Error(
          "browser profile archive exceeds the expanded size limit",
        );
      }
      await collectProfileEntries(
        profileDir,
        absolutePath,
        entries,
        uncompressedBytes,
      );
      continue;
    }

    // Chromium profile sockets, FIFOs, devices, and symlinks are runtime
    // state, not portable profile data. Skipping them also prevents archive
    // imports from creating links that could escape the profile directory.
    if (!stat.isFile()) continue;
    // REFUSE BEFORE READING. The aggregate check below runs after `readFile`
    // has already allocated the whole file, so a single oversized entry — a
    // large site-storage blob in a real profile — exhausts memory on the way
    // to being rejected. `stat` is already in hand; ask it first.
    if (
      uncompressedBytes.value + stat.size >
      MAX_BROWSER_PROFILE_UNCOMPRESSED_BYTES
    ) {
      throw new Error("browser profile archive exceeds the expanded size limit");
    }
    const contents = await readFile(absolutePath);
    const header = makeTarHeader(
      archivePath,
      "file",
      contents.byteLength,
      stat.mode,
    );
    const padding = Buffer.alloc(
      (TAR_BLOCK_BYTES - (contents.byteLength % TAR_BLOCK_BYTES)) %
        TAR_BLOCK_BYTES,
    );
    entries.push(header, contents, padding);
    uncompressedBytes.value +=
      header.byteLength + contents.byteLength + padding.byteLength;
    if (uncompressedBytes.value > MAX_BROWSER_PROFILE_UNCOMPRESSED_BYTES) {
      throw new Error(
        "browser profile archive exceeds the expanded size limit",
      );
    }
  }
}

function parseTarNumber(
  header: Buffer,
  offset: number,
  length: number,
): number {
  const raw = header
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/, "")
    .trim();
  if (!raw) return 0;
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("browser profile archive contains invalid metadata");
  }
  return value;
}

function parseTarString(
  header: Buffer,
  offset: number,
  length: number,
): string {
  return header
    .subarray(offset, offset + length)
    .toString("utf8")
    .replace(/\0.*$/, "");
}

function isZeroTarBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function assertTarChecksum(header: Buffer): void {
  const expected = parseTarNumber(header, 148, 8);
  const actual = header.reduce(
    (sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte),
    0,
  );
  if (actual !== expected) {
    throw new Error("browser profile archive has an invalid checksum");
  }
}

async function ensureSafeDirectory(
  profileDir: string,
  directory: string,
): Promise<void> {
  const absoluteProfileDir = resolve(profileDir);
  const absoluteDirectory = resolve(directory);
  if (
    absoluteDirectory !== absoluteProfileDir &&
    !absoluteDirectory.startsWith(`${absoluteProfileDir}${sep}`)
  ) {
    throw new Error("browser profile archive contains an unsafe path");
  }

  const relativeDirectory = relative(absoluteProfileDir, absoluteDirectory);
  let current = absoluteProfileDir;
  for (const segment of relativeDirectory ? relativeDirectory.split(sep) : []) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("browser profile archive targets a symbolic link");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

/** Pack a Chromium user-data-dir, excluding caches and singleton locks. */
export async function exportBrowserProfileArchive(
  profileDir: string,
): Promise<Uint8Array> {
  const entries: Buffer[] = [];
  const uncompressedBytes = { value: 0 };
  await collectProfileEntries(
    profileDir,
    profileDir,
    entries,
    uncompressedBytes,
  );
  entries.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
  const archive = gzipSync(Buffer.concat(entries), {
    portable: true,
    mtime: 0,
  });
  if (archive.byteLength > MAX_BROWSER_PROFILE_ARCHIVE_BYTES) {
    throw new Error("browser profile archive exceeds the 256 MB limit");
  }
  return new Uint8Array(archive);
}

/** Safely unpack a profile archive before Chromium launches. */
export async function importBrowserProfileArchive(
  profileDir: string,
  archive: Uint8Array,
  options: { maxUncompressedBytes?: number } = {},
): Promise<void> {
  const maxUncompressed =
    options.maxUncompressedBytes ?? MAX_BROWSER_PROFILE_UNCOMPRESSED_BYTES;
  if (archive.byteLength <= 0) {
    throw new Error("browser profile archive is empty");
  }
  if (archive.byteLength > MAX_BROWSER_PROFILE_ARCHIVE_BYTES) {
    throw new Error("browser profile archive exceeds the 256 MB limit");
  }

  // BOUND THE INFLATE, not its result. Checking the expanded size after
  // `gunzipSync` returns is too late: the allocation has already happened, so
  // 256 MB of gzipped zeros (~1000:1) asks for ~256 GB and takes the process
  // with it — and on hosted that process is a shared multi-tenant replica that
  // any signed-in user can reach by uploading an archive. `maxOutputLength`
  // makes zlib stop and throw as soon as the output WOULD exceed the bound, so
  // peak allocation is the bound plus one chunk. Its boundary is the same
  // strict `>` the old post-hoc check used, so no archive changes verdict.
  let tarball: Buffer;
  try {
    tarball = gunzipSync(Buffer.from(archive), {
      maxOutputLength: maxUncompressed,
    });
  } catch (error) {
    // Narrowed by code deliberately: a corrupt archive throws Z_DATA_ERROR and
    // must not be relabelled as a size problem, or an operator goes hunting for
    // a limit that was never the cause.
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(
        "browser profile archive exceeds the expanded size limit",
      );
    }
    throw error;
  }
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await ensureSafeDirectory(profileDir, profileDir);

  let offset = 0;
  let sawEnd = false;
  while (offset + TAR_BLOCK_BYTES <= tarball.byteLength) {
    const header = tarball.subarray(offset, offset + TAR_BLOCK_BYTES);
    offset += TAR_BLOCK_BYTES;
    if (isZeroTarBlock(header)) {
      if (sawEnd) break;
      sawEnd = true;
      continue;
    }
    if (sawEnd) {
      throw new Error("browser profile archive has data after its end marker");
    }

    assertTarChecksum(header);
    const name = parseTarString(header, 0, 100);
    const prefix = parseTarString(header, 345, 155);
    const archivePath = prefix ? `${prefix}/${name}` : name;
    assertSafeArchivePath(archivePath);
    const size = parseTarNumber(header, 124, 12);
    if (size > tarball.byteLength - offset) {
      throw new Error("browser profile archive is truncated");
    }
    if (
      !archivePath ||
      archivePath === "." ||
      isExcludedProfilePath(archivePath)
    ) {
      offset += Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
      continue;
    }

    const kind = header[156];
    const target = join(profileDir, ...archivePath.split("/"));
    if (kind === 0x35) {
      if (size !== 0)
        throw new Error("browser profile directory has file data");
      await ensureSafeDirectory(profileDir, target);
    } else if (kind === 0x30 || kind === 0) {
      const parent = resolve(target, "..");
      await ensureSafeDirectory(profileDir, parent);
      try {
        if ((await lstat(target)).isSymbolicLink()) {
          throw new Error("browser profile archive targets a symbolic link");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeFile(target, tarball.subarray(offset, offset + size), {
        mode: 0o600,
      });
    } else {
      throw new Error("browser profile archive contains an unsupported entry");
    }

    offset += Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }

  if (!sawEnd) {
    throw new Error("browser profile archive is missing its end marker");
  }
}
