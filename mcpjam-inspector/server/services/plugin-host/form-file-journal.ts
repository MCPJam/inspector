import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FORM_FILE_RETENTION_MS = 30 * 60_000;
export const FORM_FILE_DIRECTORY = join(
  tmpdir(),
  `mcpjam-owned-form-files-v1-${process.getuid?.() ?? "local"}`,
);
const MARKER = "ownership.json";
const ENTRY = /^mcpjam-form-[A-Za-z0-9]{6}$/;
const DELETING = /^deleting-([A-Za-z0-9]{6})-[0-9a-f-]{36}$/;
type Identity = { dev: string; ino: string };
type Ownership = {
  version: 1;
  name: string;
  identity: Identity;
  createdAt: number;
  expiresAt: number;
  bindingDigest: string;
  bytes: number;
};
export type FilePlacement = {
  root: string;
  payload: string;
  ownership: Ownership;
};
const identity = (value: { dev: bigint; ino: bigint }): Identity => ({
  dev: String(value.dev),
  ino: String(value.ino),
});
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

/** Cleanup ownership only. Records cannot revive grants, sources, approvals or wire
 * receipts. Every placement is conservatively retained until its original deadline
 * after restart, even if the previous process had not yet promoted it.
 */
export class PluginFormFileJournal {
  private directory?: { path: string; identity: Identity };
  constructor(
    private readonly base = FORM_FILE_DIRECTORY,
    private readonly now = Date.now,
  ) {}

  private async privateDirectory(path: string) {
    const value = await lstat(path, { bigint: true });
    if (
      !value.isDirectory() ||
      (value.mode & 0o777n) !== 0o700n ||
      (process.getuid && value.uid !== BigInt(process.getuid()))
    )
      throw new Error("Invalid owned upload directory");
    return identity(value);
  }
  private async root() {
    if (!this.directory) {
      await mkdir(this.base, { recursive: true, mode: 0o700 });
      const value = await this.privateDirectory(this.base);
      this.directory = { path: await realpath(this.base), identity: value };
    }
    if (
      (await realpath(this.base)) !== this.directory.path ||
      !same(await this.privateDirectory(this.base), this.directory.identity)
    )
      throw new Error("Owned upload directory changed");
    return this.directory.path;
  }
  private async syncDirectory(path: string, expected: Identity) {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      if (!same(identity(await handle.stat({ bigint: true })), expected))
        throw new Error("Owned upload directory changed");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async reserve(bindingDigest: string, bytes: number): Promise<FilePlacement> {
    if (
      !/^[0-9a-f]{64}$/.test(bindingDigest) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > 768 * 1024
    )
      throw new Error("Invalid owned upload reservation");
    const base = await this.root();
    const root = await mkdtemp(join(base, "mcpjam-form-"));
    const rootIdentity = await this.privateDirectory(root);
    const name = root.slice(base.length + 1);
    const createdAt = this.now();
    const ownership: Ownership = {
      version: 1,
      name,
      identity: rootIdentity,
      createdAt,
      expiresAt: createdAt + FORM_FILE_RETENTION_MS,
      bindingDigest,
      bytes,
    };
    try {
      const handle = await open(
        join(root, MARKER),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(JSON.stringify(ownership));
        await handle.sync();
      } finally {
        await handle.close();
      }
      // No user bytes may be written until the record and directory links have
      // been flushed. A crash before this point can only leave an empty reservation.
      await this.syncDirectory(root, rootIdentity);
      await this.syncDirectory(base, this.directory!.identity);
      const payload = join(root, "payload");
      await mkdir(payload, { mode: 0o700 });
      return { root, payload, ownership };
    } catch (error) {
      if (same(await this.privateDirectory(root), rootIdentity))
        await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
  private async read(root: string, originalName: string) {
    const rootIdentity = await this.privateDirectory(root);
    const handle = await open(
      join(root, MARKER),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const value = await handle.stat({ bigint: true });
      if (
        !value.isFile() ||
        value.size > 4096n ||
        (value.mode & 0o777n) !== 0o600n ||
        (process.getuid && value.uid !== BigInt(process.getuid()))
      )
        throw new Error("Invalid owned upload record");
      const record = JSON.parse(await handle.readFile("utf8")) as Ownership;
      if (
        Object.keys(record).sort().join() !==
          "bindingDigest,bytes,createdAt,expiresAt,identity,name,version" ||
        record.version !== 1 ||
        record.name !== originalName ||
        !ENTRY.test(record.name) ||
        !same(record.identity, rootIdentity) ||
        !Number.isSafeInteger(record.createdAt) ||
        record.createdAt < 0 ||
        record.createdAt > this.now() + 60_000 ||
        record.expiresAt !== record.createdAt + FORM_FILE_RETENTION_MS ||
        typeof record.bindingDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(record.bindingDigest) ||
        !Number.isSafeInteger(record.bytes) ||
        record.bytes < 0 ||
        record.bytes > 768 * 1024
      )
        throw new Error("Invalid owned upload record");
      return record;
    } finally {
      await handle.close();
    }
  }
  private async remove(root: string, record: Ownership, quarantined = false) {
    const base = await this.root();
    if (!same(await this.privateDirectory(root), record.identity))
      throw new Error("Owned upload placement changed");
    const target = quarantined
      ? root
      : join(
          base,
          `deleting-${record.name.slice(
            "mcpjam-form-".length,
          )}-${randomUUID()}`,
        );
    if (!quarantined) {
      await rename(root, target);
      await this.syncDirectory(base, this.directory!.identity);
    }
    // Recheck after the atomic move; never traverse a substituted root or a
    // namespace symlink. Recursive rm removes child links without following them.
    await this.root();
    if (!same(await this.privateDirectory(target), record.identity))
      throw new Error("Owned upload placement changed");
    await rm(target, { recursive: true, force: true });
    await this.syncDirectory(base, this.directory!.identity);
  }
  async release(placement: FilePlacement) {
    const base = await this.root();
    if (placement.root !== join(base, placement.ownership.name))
      throw new Error("Invalid owned upload placement");
    try {
      const record = await this.read(placement.root, placement.ownership.name);
      if (JSON.stringify(record) !== JSON.stringify(placement.ownership))
        throw new Error("Owned upload record changed");
      await this.remove(placement.root, record);
    } catch (error) {
      if (!missing(error)) throw error;
      // A concurrent completed removal is harmless. A missing ownership marker
      // with a still-present tree is a refusal, so cleanup does not silently
      // forget unqualified bytes.
      try {
        await lstat(placement.root);
      } catch (absent) {
        if (missing(absent)) return;
        throw absent;
      }
      throw new Error("Owned upload record missing");
    }
  }
  async sweep() {
    const base = await this.root();
    const result = { retained: 0, removed: 0, refused: 0, overflow: false };
    const directory = await opendir(base);
    let count = 0;
    for await (const entry of directory) {
      if (++count > 1024) {
        result.overflow = true;
        break;
      }
      const deleting = DELETING.exec(entry.name);
      if (!ENTRY.test(entry.name) && !deleting) continue;
      const root = join(base, entry.name);
      const name = deleting ? `mcpjam-form-${deleting[1]}` : entry.name;
      try {
        let record: Ownership;
        try {
          record = await this.read(root, name);
        } catch (error) {
          // Before journal creation there can be an empty reservation. rmdir
          // never removes contents; a concurrent writer simply makes it refuse.
          if (missing(error) && !deleting) {
            await this.privateDirectory(root);
            const value = await lstat(root);
            if (value.mtimeMs + FORM_FILE_RETENTION_MS <= this.now()) {
              await this.root();
              await rmdir(root);
              result.removed++;
              continue;
            }
            // ENOENT here belongs to the marker, not the surviving root. Retain
            // and report it rather than treating it as concurrent cleanup.
            throw new Error("Owned upload record missing");
          }
          throw error;
        }
        if (deleting || record.expiresAt <= this.now()) {
          await this.remove(root, record, !!deleting);
          result.removed++;
        } else result.retained++;
      } catch (error) {
        if (!missing(error)) result.refused++;
      }
    }
    return result;
  }
}
