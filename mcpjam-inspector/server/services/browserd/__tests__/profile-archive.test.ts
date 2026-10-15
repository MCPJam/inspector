import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportBrowserProfileArchive,
  importBrowserProfileArchive,
} from "../profile-archive.js";

const temporaryDirectories: string[] = [];

// Reads the archive itself rather than an import of it: import applies the
// same exclusions, so a round-trip would pass even if the files were shipped.
function tarEntryNames(tarball: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset + 512 <= tarball.byteLength) {
    const header = tarball.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/, "");
    const prefix = field(345, 155);
    const name = field(0, 100);
    names.push(prefix ? `${prefix}/${name}` : name);
    const size = Number.parseInt(field(124, 12), 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("browser profile archives", () => {
  it("round-trips profile files while omitting caches and singleton locks", async () => {
    const source = await mkdtemp(join(tmpdir(), "mcpjam-profile-source-"));
    const target = await mkdtemp(join(tmpdir(), "mcpjam-profile-target-"));
    temporaryDirectories.push(source, target);
    await mkdir(join(source, "Default", "Cache"), { recursive: true });
    await mkdir(join(source, "Default"), { recursive: true });
    await writeFile(
      join(source, "Default", "Preferences"),
      '{"homepage":"https://example.com"}',
    );
    await writeFile(join(source, "Default", "Cache", "discarded"), "cache");
    await writeFile(join(source, "SingletonLock"), "lock");

    const archive = await exportBrowserProfileArchive(source);
    await importBrowserProfileArchive(target, archive);

    await expect(
      readFile(join(target, "Default", "Preferences"), "utf8"),
    ).resolves.toContain("example.com");
    await expect(
      readFile(join(target, "Default", "Cache", "discarded")),
    ).rejects.toThrow();
    await expect(readFile(join(target, "SingletonLock"))).rejects.toThrow();
  });

  it.each(["Default", "Profile 1", "Guest Profile"])(
    "leaves passwords, autofill, history and extensions out of %s but keeps its sessions",
    async (profileName) => {
      const source = await mkdtemp(join(tmpdir(), "mcpjam-profile-private-"));
      temporaryDirectories.push(source);
      const profile = join(source, profileName);
      for (const directory of [
        "Network",
        "Local Storage/leveldb",
        "IndexedDB/https_example.com_0.indexeddb.leveldb",
        "Session Storage",
        "Extensions/abc",
        "Extension State",
        "Local Extension Settings/abc",
        "Sessions",
        "Sync Data/LevelDB",
      ]) {
        await mkdir(join(profile, ...directory.split("/")), {
          recursive: true,
        });
      }
      const kept = [
        "Cookies",
        "Cookies-journal",
        "Network/Cookies",
        "Network/Cookies-wal",
        "Preferences",
        "Local Storage/leveldb/000003.log",
        "IndexedDB/https_example.com_0.indexeddb.leveldb/000003.log",
        "Session Storage/000003.log",
      ];
      const privateStores = [
        "Login Data",
        "Login Data For Account",
        "Affiliation Database",
        "Web Data",
        "Account Web Data",
        "History",
        "Media History",
        "Visited Links",
        "Top Sites",
        "Shortcuts",
        "Favicons",
        "Network Action Predictor",
        "Current Session",
        "Last Session",
        "Current Tabs",
        "Last Tabs",
        "Extension Cookies",
      ];
      const dropped = [
        ...privateStores.flatMap((store) => [
          store,
          `${store}-journal`,
          `${store}-wal`,
          `${store}-shm`,
        ]),
        "Sessions/Session_1",
        "Sync Data/LevelDB/000003.log",
        "Extensions/abc/manifest.json",
        "Extension State/000003.log",
        "Local Extension Settings/abc/000003.log",
      ];
      for (const path of [...kept, ...dropped]) {
        await writeFile(join(profile, ...path.split("/")), path);
      }

      const archived = tarEntryNames(
        gunzipSync(await exportBrowserProfileArchive(source)),
      );

      for (const path of kept) {
        expect(archived).toContain(`${profileName}/${path}`);
      }
      const leaked = archived.filter((entry) =>
        dropped.some((path) => entry.startsWith(`${profileName}/${path}`)),
      );
      expect(leaked).toEqual([]);
      for (const directory of ["Extensions", "Sessions", "Sync Data"]) {
        expect(archived).not.toContain(`${profileName}/${directory}`);
      }
    },
  );

  it("refuses a gzip bomb without allocating its expansion", async () => {
    const target = await mkdtemp(join(tmpdir(), "mcpjam-profile-bomb-"));
    temporaryDirectories.push(target);

    // 64 MiB of zeros gzips to ~64 KB. Against a 1 MiB cap this is the shape
    // of the real attack — a small upload whose EXPANSION is what kills the
    // process — without needing a 1 GiB allocation to prove it. Before the
    // fix this inflated all 64 MiB and only then measured; now zlib refuses
    // mid-inflate, so the test is fast as well as green.
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024, 0));
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);

    const before = process.memoryUsage().arrayBuffers;
    await expect(
      importBrowserProfileArchive(target, bomb, {
        maxUncompressedBytes: 1024 * 1024,
      }),
    ).rejects.toThrow(/exceeds the expanded size limit/);
    // The refusal must not have cost the expansion it refused.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(
      16 * 1024 * 1024,
    );
  });

  it("reports a corrupt archive as corrupt, not as oversized", async () => {
    const target = await mkdtemp(join(tmpdir(), "mcpjam-profile-corrupt-"));
    temporaryDirectories.push(target);
    // Narrowing the catch by error code is what keeps these two apart: a
    // truncated upload must not send an operator hunting for a size limit.
    await expect(
      importBrowserProfileArchive(target, Buffer.from("not a gzip stream")),
    ).rejects.toThrow(/incorrect header check/);
  });

  it("accepts an archive whose expansion is exactly the cap", async () => {
    const source = await mkdtemp(join(tmpdir(), "mcpjam-profile-exact-"));
    const target = await mkdtemp(join(tmpdir(), "mcpjam-profile-exact-out-"));
    temporaryDirectories.push(source, target);
    await writeFile(join(source, "Preferences"), "x".repeat(1024));

    // Pins the boundary from BOTH sides: `maxOutputLength` permits exactly N
    // and refuses N+1, which is the same predicate as the `> N` check it
    // replaced. The cap is derived from the archive's real expanded size — a
    // round number comfortably above it would pass whether zlib used `>` or
    // `>=`, and so would not pin anything. If zlib ever moved to `>=`,
    // archives that imported yesterday would start failing, and this is what
    // catches it.
    const archive = await exportBrowserProfileArchive(source);
    const expanded = gunzipSync(archive).byteLength;

    await expect(
      importBrowserProfileArchive(target, archive, {
        maxUncompressedBytes: expanded,
      }),
    ).resolves.toBeUndefined();
    await expect(
      readFile(join(target, "Preferences"), "utf8"),
    ).resolves.toContain("x");

    // One byte under the same archive must be refused, or "exactly the cap
    // passes" would be vacuous.
    const tooTight = await mkdtemp(join(tmpdir(), "mcpjam-profile-tight-"));
    temporaryDirectories.push(tooTight);
    await expect(
      importBrowserProfileArchive(tooTight, archive, {
        maxUncompressedBytes: expanded - 1,
      }),
    ).rejects.toThrow(/exceeds the expanded size limit/);
  });
});
