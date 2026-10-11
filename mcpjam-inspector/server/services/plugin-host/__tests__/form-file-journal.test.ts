import { afterEach, describe, expect, it } from "vitest";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PluginFormFileJournal,
  FORM_FILE_RETENTION_MS,
} from "../form-file-journal";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "form-journal-test-"));
  roots.push(root);
  const base = join(root, "owned");
  let now = Date.now();
  const journal = new PluginFormFileJournal(base, () => now);
  return {
    root,
    base,
    journal,
    expire: () => {
      now += FORM_FILE_RETENTION_MS + 1;
    },
  };
}
describe("durable owned placement cleanup", () => {
  it("records bounded data-only ownership before a private empty payload exists", async () => {
    const f = await fixture();
    const placed = await f.journal.reserve("a".repeat(64), 5);
    const record = JSON.parse(
      await readFile(join(placed.root, "ownership.json"), "utf8"),
    );
    expect(record).toEqual(placed.ownership);
    expect(record.expiresAt - record.createdAt).toBe(FORM_FILE_RETENTION_MS);
    expect(await readdir(placed.payload)).toEqual([]);
    expect((await stat(join(placed.root, "ownership.json"))).mode & 0o777).toBe(
      0o600,
    );
    expect((await stat(placed.payload)).mode & 0o777).toBe(0o700);
    expect(Object.keys(record).sort()).toEqual([
      "bindingDigest",
      "bytes",
      "createdAt",
      "expiresAt",
      "identity",
      "name",
      "version",
    ]);
    await f.journal.release(placed);
    expect(await readdir(f.base)).toEqual([]);
  });
  it("preserves uncertain bytes across independent journals until the exact original deadline", async () => {
    const f = await fixture();
    const placed = await f.journal.reserve("a".repeat(64), 5);
    await writeFile(
      join(placed.payload, "exact.bin"),
      Buffer.from([0, 255, 128, 1, 0]),
    );
    expect(await new PluginFormFileJournal(f.base).sweep()).toEqual({
      retained: 1,
      removed: 0,
      refused: 0,
      overflow: false,
    });
    f.expire();
    expect((await f.journal.sweep()).removed).toBe(1);
    await expect(access(placed.root)).rejects.toThrow();
  });
  it("finishes a previously committed quarantine removal even before retention", async () => {
    const f = await fixture();
    const placed = await f.journal.reserve("a".repeat(64), 5);
    const target = join(
      f.base,
      `deleting-${placed.ownership.name.slice(
        "mcpjam-form-".length,
      )}-00000000-0000-4000-8000-000000000000`,
    );
    await rename(placed.root, target);
    expect((await new PluginFormFileJournal(f.base).sweep()).removed).toBe(1);
    expect(await readdir(f.base)).toEqual([]);
  });
  it("removes expired child links without following them into another disposable directory", async () => {
    const f = await fixture();
    const outside = join(f.root, "other");
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "preserved");
    const placed = await f.journal.reserve("a".repeat(64), 5);
    await symlink(outside, join(placed.payload, "link"));
    f.expire();
    expect((await f.journal.sweep()).removed).toBe(1);
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("preserved");
  });
  it.each([
    "namespace-link",
    "entry-link",
    "marker-link",
    "permissions",
    "identity",
    "expiry",
    "malformed",
  ])(
    "refuses %s without deleting substituted or foreign contents",
    async (kind) => {
      const f = await fixture();
      const placed = await f.journal.reserve("a".repeat(64), 5);
      const outside = join(f.root, "keep");
      await mkdir(outside, { mode: 0o700 });
      await writeFile(join(outside, "sentinel"), "preserved");
      if (kind === "namespace-link") {
        await rename(f.base, join(f.root, "original"));
        await symlink(outside, f.base);
      } else if (kind === "entry-link") {
        await rm(placed.root, { recursive: true });
        await symlink(outside, placed.root);
      } else if (kind === "marker-link") {
        await rm(join(placed.root, "ownership.json"));
        await symlink(
          join(outside, "sentinel"),
          join(placed.root, "ownership.json"),
        );
      } else if (kind === "permissions") await chmod(placed.root, 0o755);
      else {
        const marker = {
          ...placed.ownership,
          ...(kind === "identity"
            ? { identity: { dev: "0", ino: "0" } }
            : kind === "expiry"
            ? { expiresAt: placed.ownership.expiresAt + 1 }
            : {}),
        };
        await writeFile(
          join(placed.root, "ownership.json"),
          kind === "malformed" ? "broken" : JSON.stringify(marker),
        );
      }
      f.expire();
      if (kind === "namespace-link")
        await expect(f.journal.sweep()).rejects.toThrow();
      else expect((await f.journal.sweep()).refused).toBe(1);
      expect(await readFile(join(outside, "sentinel"), "utf8")).toBe(
        "preserved",
      );
      await expect(f.journal.release(placed)).rejects.toThrow();
    },
  );
  it("cleans only aged empty pre-journal reservations, retaining unrecorded contents and unknown names", async () => {
    const f = await fixture();
    await f.journal.sweep();
    for (const name of [
      "mcpjam-form-ABCDEF",
      "mcpjam-form-BCDEFG",
      "foreign",
    ]) {
      const path = join(f.base, name);
      await mkdir(path, { mode: 0o700 });
      if (name !== "mcpjam-form-ABCDEF")
        await writeFile(join(path, "keep"), "preserved");
      await utimes(path, new Date(0), new Date(0));
    }
    expect(await f.journal.sweep()).toEqual({
      retained: 0,
      removed: 1,
      refused: 1,
      overflow: false,
    });
    expect(await readdir(f.base)).toEqual(
      expect.arrayContaining(["mcpjam-form-BCDEFG", "foreign"]),
    );
  });
  it("refuses forged reservation paths and changed journal metadata on normal terminal release", async () => {
    const f = await fixture();
    const placed = await f.journal.reserve("a".repeat(64), 5);
    await expect(
      f.journal.release({ ...placed, root: f.root }),
    ).rejects.toThrow();
    await writeFile(
      join(placed.root, "ownership.json"),
      JSON.stringify({ ...placed.ownership, bindingDigest: "b".repeat(64) }),
    );
    await expect(f.journal.release(placed)).rejects.toThrow();
    expect(await readdir(f.base)).toHaveLength(1);
  });
  it("does not silently forget a surviving tree whose ownership marker disappeared", async () => {
    const f = await fixture();
    const placed = await f.journal.reserve("a".repeat(64), 5);
    await writeFile(join(placed.payload, "exact"), "bytes");
    await rm(join(placed.root, "ownership.json"));
    await expect(f.journal.release(placed)).rejects.toThrow("record missing");
    f.expire();
    expect((await f.journal.sweep()).refused).toBe(1);
    expect(await readFile(join(placed.payload, "exact"), "utf8")).toBe("bytes");
  });
});
