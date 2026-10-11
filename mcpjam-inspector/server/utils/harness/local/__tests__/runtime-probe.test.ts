/**
 * The candidate startup probe, for real: the Inspector layer's launcher is
 * started by the pack's `bin/node` in probe mode, resolves the bridge's vendor
 * import through its hook into the pack, and the vendor binary answers its
 * version handshake. The fixture packs' `bin/node` is a shell wrapper around
 * this Node (POSIX only), and their vendor binaries are small scripts.
 */
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeRuntimeCandidate } from "../runtime-probe.js";
import { localPackTarget } from "../targets.js";
import { removeTestTree } from "./remove-test-tree.js";

const POSIX = process.platform !== "win32";
const TARGET = localPackTarget()!;
let base: string;

async function exe(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

async function packWithNode(name: string, harness: string): Promise<string> {
  const root = join(base, name, harness);
  await mkdir(join(root, "bin"), { recursive: true });
  await exe(join(root, "bin", "node"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  return root;
}

async function codexPack(name: string, opts: { reports?: string; codexJs?: boolean } = {}): Promise<string> {
  const root = await packWithNode(name, "codex");
  const pkg = join(root, "node_modules", "@openai", "codex");
  await mkdir(join(pkg, "bin"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.42.0" }));
  if (opts.codexJs !== false) {
    await writeFile(join(pkg, "bin", "codex.js"), `console.log(${JSON.stringify(`codex-cli ${opts.reports ?? "0.42.0"}`)});\n`);
  }
  return root;
}

async function claudePack(name: string, opts: { sdk?: boolean; cli?: string } = {}): Promise<string> {
  const root = await packWithNode(name, "claude-code");
  if (opts.sdk !== false) {
    const sdk = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
    await mkdir(sdk, { recursive: true });
    await writeFile(
      join(sdk, "package.json"),
      JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.0", type: "module", exports: { ".": "./sdk.mjs" } }),
    );
    await writeFile(join(sdk, "sdk.mjs"), "export function query() {}\n");
  }
  const platform = join(root, "node_modules", "@anthropic-ai", `claude-agent-sdk-${TARGET}`);
  await mkdir(platform, { recursive: true });
  await exe(join(platform, "claude"), opts.cli ?? "#!/bin/sh\necho '2.1.7 (Claude Code)'\n");
  return root;
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-probe-test-")));
});
afterAll(async () => {
  await removeTestTree(base);
});

const probe = (harnessId: "claude-code" | "codex", packRoot: string) =>
  probeRuntimeCandidate({ harnessId, packRoot, platform: process.platform as "linux", target: TARGET, layerRuntimeRoot: join(base, "runtime") });

describe.skipIf(!POSIX)("the candidate startup probe", () => {
  it("passes a Claude Code pack whose SDK the layer resolves and whose CLI answers", async () => {
    expect(await probe("claude-code", await claudePack("good-claude"))).toEqual({
      ok: true,
      node: process.version,
      vendorVersion: "2.1.7",
    });
  });

  it("fails a Claude Code pack whose agent SDK the layer cannot reach", async () => {
    const result = await probe("claude-code", await claudePack("no-sdk", { sdk: false }));
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/did not start on the candidate pack/) });
  });

  it("fails a Claude Code pack whose native CLI does not answer --version", async () => {
    const result = await probe("claude-code", await claudePack("bad-cli", { cli: "#!/bin/sh\nexit 3\n" }));
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/did not answer --version/) });
  });

  it("passes a Codex pack whose codex.js reports the version it carries", async () => {
    expect(await probe("codex", await codexPack("good-codex"))).toEqual({ ok: true, node: process.version, vendorVersion: "0.42.0" });
  });

  it("fails a Codex pack whose CLI reports another version, or has no codex.js", async () => {
    expect(await probe("codex", await codexPack("wrong-version", { reports: "0.41.0" }))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/did not report @openai\/codex 0\.42\.0/),
    });
    expect(await probe("codex", await codexPack("no-codex-js", { codexJs: false }))).toMatchObject({ ok: false });
  });

  it("fails a pack whose Node cannot run at all", async () => {
    const root = await codexPack("dead-node");
    await exe(join(root, "bin", "node"), "#!/bin/sh\nexit 1\n");
    expect(await probe("codex", root)).toMatchObject({ ok: false });
  });
});
