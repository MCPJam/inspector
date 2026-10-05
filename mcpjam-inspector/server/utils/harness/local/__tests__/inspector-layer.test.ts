/**
 * The Inspector layer: MCPJam's own half of a local runtime, delivered with
 * the Inspector and written to a content-addressed, read-only directory.
 *
 * What is pinned here is invariant 1 on disk: the layer's digest comes from
 * the bytes compiled into this build, a layer that does not match is replaced
 * when ensured and REFUSED before an exec, and the bridge it carries imports
 * nothing but Node builtins.
 */
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureInspectorLayer,
  inspectorLayerBase,
  inspectorLayerDigest,
  inspectorLayerFiles,
  inspectorLayerRecipeFiles,
  verifyInspectorLayer,
} from "../inspector-layer.js";
import { computeTreeDigest, digestFileSet } from "../tree-digest.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-layer-")));
});
afterEach(async () => {
  // The layer is read-only by design; make it removable again.
  const base = inspectorLayerBase(root);
  for (const name of await readdir(base).catch(() => [] as string[])) {
    await chmod(join(base, name), 0o700).catch(() => {});
    for (const file of await readdir(join(base, name)).catch(() => [] as string[])) {
      await chmod(join(base, name, file), 0o600).catch(() => {});
    }
  }
  await rm(root, { recursive: true, force: true });
});

describe("digestFileSet", () => {
  it("is exactly the digest the same files have on disk", async () => {
    const files = [
      { path: "b.mjs", content: "b" },
      { path: "a.json", content: "{}\n" },
      { path: "nested/z.txt", content: "z" },
      { path: "nested/deeper/y.txt", content: "y" },
    ];
    const dir = join(root, "tree");
    for (const file of files) {
      const full = join(dir, file.path);
      await import("node:fs/promises").then((fs) => fs.mkdir(join(full, ".."), { recursive: true }));
      await writeFile(full, file.content);
      await chmod(full, 0o444);
    }
    expect(digestFileSet(files)).toBe(await computeTreeDigest(dir));
  });

  it("refuses a path that is not canonical", () => {
    expect(() => digestFileSet([{ path: "../escape", content: "" }])).toThrow(/canonical/);
    expect(() => digestFileSet([{ path: "a", content: "" }, { path: "a", content: "" }])).toThrow(/duplicate/);
  });
});

describe("the layer's contents", () => {
  it("is Codex's bridge, host-tools entrypoint, launcher and a manifest naming the harness", () => {
    const files = inspectorLayerFiles("codex")!;
    expect(files.map((file) => file.path).sort()).toEqual([
      "bridge.mjs",
      "host-tools-mcp.mjs",
      "launcher.mjs",
      "layer.json",
    ]);
    expect(JSON.parse(files.find((file) => file.path === "layer.json")!.content)).toEqual({
      schema: "mcpjam.inspector-layer/1",
      harnessId: "codex",
    });
    // What an adapter's recipe writes: the bridge files, never the launcher.
    expect(inspectorLayerRecipeFiles("codex")!.map((file) => file.path).sort()).toEqual([
      "bridge.mjs",
      "host-tools-mcp.mjs",
    ]);
    expect(inspectorLayerDigest("codex")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("compiles every dependency into the bridge: it imports nothing but Node builtins", () => {
    for (const file of inspectorLayerFiles("codex")!) {
      if (!file.path.endsWith(".mjs")) continue;
      const bare = [...file.content.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*"([^"]+)"/g)]
        .map((match) => match[1]!)
        .filter((specifier) => !specifier.startsWith("node:") && !specifier.startsWith("."));
      const builtins = new Set(["crypto", "fs", "fs/promises", "process", "path", "os", "url", "events", "http", "https", "net", "stream", "zlib", "buffer", "tls", "util", "child_process"]);
      expect(bare.filter((specifier) => !builtins.has(specifier)), file.path).toEqual([]);
    }
  });

  it("is absent for a harness whose bridge still ships in its pack", () => {
    expect(inspectorLayerFiles("claude-code")).toBeNull();
    expect(inspectorLayerDigest("claude-code")).toBeNull();
  });
});

describe("ensureInspectorLayer", () => {
  it("writes a read-only, content-addressed tree that digests as compiled", async () => {
    const result = await ensureInspectorLayer("codex", { runtimeRoot: root });
    if (!result.ok) throw new Error(result.message);
    const { layer } = result;
    expect(layer.root).toBe(join(root, "inspector-layer", layer.digest.slice(7)));
    expect(layer.launcherPath).toBe(join(layer.root, "launcher.mjs"));
    expect(await computeTreeDigest(layer.root)).toBe(inspectorLayerDigest("codex"));
    if (process.platform !== "win32") {
      for (const name of layer.files) {
        expect((await stat(join(layer.root, name))).mode & 0o777, name).toBe(0o444);
      }
      expect((await stat(layer.root)).mode & 0o777).toBe(0o555);
    }
    // No staging directory survives a successful write.
    expect(await readdir(inspectorLayerBase(root))).toEqual([layer.digest.slice(7)]);
  });

  it("is idempotent and safe to race", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureInspectorLayer("codex", { runtimeRoot: root })),
    );
    for (const result of results) expect(result.ok).toBe(true);
    expect(await readdir(inspectorLayerBase(root))).toHaveLength(1);
  });

  it("replaces a layer whose bytes do not match, from the bytes compiled in", async () => {
    const first = await ensureInspectorLayer("codex", { runtimeRoot: root });
    if (!first.ok) throw new Error(first.message);
    const bridge = join(first.layer.root, "bridge.mjs");
    await chmod(first.layer.root, 0o700);
    await chmod(bridge, 0o600);
    await writeFile(bridge, "process.exit(0)\n");

    const second = await ensureInspectorLayer("codex", { runtimeRoot: root });
    if (!second.ok) throw new Error(second.message);
    expect(await computeTreeDigest(second.layer.root)).toBe(inspectorLayerDigest("codex"));
    expect(await readFile(join(second.layer.root, "bridge.mjs"), "utf8")).not.toBe("process.exit(0)\n");
  });

  it("refuses a harness with no layer", async () => {
    const result = await ensureInspectorLayer("claude-code", { runtimeRoot: root });
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/no Inspector layer/) });
  });
});

describe("verifyInspectorLayer, immediately before an exec", () => {
  it("passes an intact layer", async () => {
    const result = await ensureInspectorLayer("codex", { runtimeRoot: root });
    if (!result.ok) throw new Error(result.message);
    expect(await verifyInspectorLayer(result.layer)).toEqual({ ok: true });
  });

  it.each([
    ["the launcher rewritten", "launcher.mjs", "edit"],
    ["the bridge rewritten", "bridge.mjs", "edit"],
    ["a file added", "extra.mjs", "add"],
  ])("fails closed with %s — and never repairs it", async (_label, name, how) => {
    const result = await ensureInspectorLayer("codex", { runtimeRoot: root });
    if (!result.ok) throw new Error(result.message);
    await chmod(result.layer.root, 0o700);
    const path = join(result.layer.root, name);
    if (how === "edit") await chmod(path, 0o600);
    await writeFile(path, "// tampered\n");

    const verified = await verifyInspectorLayer(result.layer);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.message).toMatch(/changed after it was verified/);
    // Still tampered: verification is a refusal, not a repair.
    expect(await readFile(path, "utf8")).toBe("// tampered\n");
  });

  it("refuses a layer that is not the one compiled into this build", async () => {
    const result = await ensureInspectorLayer("codex", { runtimeRoot: root });
    if (!result.ok) throw new Error(result.message);
    const verified = await verifyInspectorLayer({ ...result.layer, digest: `sha256:${"0".repeat(64)}` });
    expect(verified).toEqual({ ok: false, message: expect.stringMatching(/not the one compiled/) });
  });
});
