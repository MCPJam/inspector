import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportBrowserProfileArchive,
  importBrowserProfileArchive,
} from "../profile-archive.js";

const temporaryDirectories: string[] = [];

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

    // Pins the boundary: `maxOutputLength` permits exactly N and refuses N+1,
    // which is the same predicate as the `> N` check it replaced. If zlib ever
    // moved to `>=`, archives that imported yesterday would start failing and
    // this is what would catch it.
    const archive = await exportBrowserProfileArchive(source);
    await expect(
      importBrowserProfileArchive(target, archive, {
        maxUncompressedBytes: 10 * 1024,
      }),
    ).resolves.toBeUndefined();
    await expect(
      readFile(join(target, "Preferences"), "utf8"),
    ).resolves.toContain("x");
  });
});
