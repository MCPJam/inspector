/**
 * The Inspector layer never renames a directory its owner cannot write.
 *
 * macOS (APFS/BSD) refuses that rename with EACCES even within one parent;
 * Linux allows it. CI runs this suite on Linux, where the real rename would
 * pass whatever the mode, so the rule is asserted on the call itself: every
 * directory handed to `rename` must still be owner-writable at that moment.
 * Breaking it broke every macOS session (the layer could not be written).
 */
import { chmod, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renamedUnwritable: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      const before = await actual.lstat(from).catch(() => null);
      if (before?.isDirectory() && (before.mode & 0o200) === 0) renamedUnwritable.push(from);
      return actual.rename(from, to);
    },
  };
});

const { ensureInspectorLayer, inspectorLayerBase } = await import("../inspector-layer.js");

let root: string;
beforeEach(async () => {
  renamedUnwritable.length = 0;
  root = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-layer-rename-")));
});
afterEach(async () => {
  const base = inspectorLayerBase(root);
  for (const name of await readdir(base).catch(() => [] as string[])) {
    await chmod(join(base, name), 0o700).catch(() => {});
    for (const file of await readdir(join(base, name)).catch(() => [] as string[])) {
      await chmod(join(base, name, file), 0o600).catch(() => {});
    }
  }
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("Inspector layer renames", () => {
  it("writes a layer without renaming a sealed directory", async () => {
    const result = await ensureInspectorLayer("codex", { runtimeRoot: root });
    if (!result.ok) throw new Error(result.message);
    expect(renamedUnwritable).toEqual([]);
  });

  it("retires a sealed layer that does not match without renaming it sealed", async () => {
    const first = await ensureInspectorLayer("codex", { runtimeRoot: root });
    if (!first.ok) throw new Error(first.message);
    const launcher = join(first.layer.root, "launcher.mjs");
    await chmod(launcher, 0o644);
    await writeFile(launcher, "// tampered\n");
    await chmod(launcher, 0o444);

    const repaired = await ensureInspectorLayer("codex", { runtimeRoot: root });
    if (!repaired.ok) throw new Error(repaired.message);
    expect(renamedUnwritable).toEqual([]);
    expect(await fs.readFile(launcher, "utf8")).not.toBe("// tampered\n");
  });
});
