import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
