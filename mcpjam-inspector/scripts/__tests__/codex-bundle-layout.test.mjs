import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleCodexAppServerBridgeSources } from "../bundle-codex-appserver-bridge.mjs";

const inspectorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const digest = (source) => createHash("sha256").update(source).digest("hex");

test("Codex artifacts retain their bytes when a worktree shares dependencies", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "codex-bundle-layout-"));
  const worktree = join(scratch, "nested", "worktree");
  const inspector = join(worktree, "mcpjam-inspector");
  try {
    await mkdir(join(inspector, "scripts", "lib"), { recursive: true });
    for (const name of ["bundle-codex-appserver-bridge.mjs", "lib/bridge-control-plugin.mjs"]) {
      await cp(join(inspectorRoot, "scripts", name), join(inspector, "scripts", name));
    }
    // Junctions, unlike directory symlinks, need no privilege on Windows; the
    // two files are copied because a junction cannot point at a file.
    for (const name of ["server", "shared", "node_modules"]) {
      await symlink(join(inspectorRoot, name), join(inspector, name), "junction");
    }
    for (const name of ["tsconfig.json", "package.json"]) {
      await cp(join(inspectorRoot, name), join(inspector, name));
    }
    await symlink(join(inspectorRoot, "..", "node_modules"), join(worktree, "node_modules"), "junction");
    const shared = await import(pathToFileURL(join(inspector, "scripts", "bundle-codex-appserver-bridge.mjs")).href);
    for (const layer of [false, true]) {
      const original = await bundleCodexAppServerBridgeSources({ layer });
      const relocated = await shared.bundleCodexAppServerBridgeSources({ layer });
      for (const entry of ["bridgeSource", "hostToolsSource"]) {
        assert.equal(digest(relocated[entry]), digest(original[entry]), `${entry}, layer=${layer}`);
      }
      assert.equal(original.bridgeSource.split('msg.type === "mcpjam-refresh-mcp"').length - 1, 1);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
