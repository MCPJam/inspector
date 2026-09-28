import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createClaudeCodeHarness } from "../../claude-code-bootstrap.js";
import { LOCAL_HARNESS_MANIFEST } from "../compatibility.js";
import { installClaudeCodePackRecipe } from "../../../../../scripts/build-local-harness-pack.mjs";

const directories: string[] = [];
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mcpjam-pack-bootstrap-"));
  directories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("the local pack uses the application's patched Claude Code recipe", () => {
  it("stages byte-identical bootstrap files and delays .npmrc until install completes", async () => {
    const root = await scratch();
    const raw = await createClaudeCode().getBootstrap!();
    const runtime = await createClaudeCodeHarness().getBootstrap!();
    let installed = false;
    const result = await installClaudeCodePackRecipe(root, async () => {
      expect(await readdir(root)).not.toContain(".npmrc");
      // The signed build's dependency recipe remains the adapter's frozen one.
      for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
        expect(await readFile(join(root, name), "utf8")).toBe(
          raw.files.find((file) => basename(file.path) === name)?.content,
        );
      }
      installed = true;
    });
    expect(installed).toBe(true);

    const names = runtime.files.map((file) => basename(file.path)).sort();
    expect((await readdir(root)).sort()).toEqual(names);
    expect([...LOCAL_HARNESS_MANIFEST["claude-code"].adapterBootstrapFiles].sort())
      .toEqual(names);
    for (const file of runtime.files) {
      expect(await readFile(join(root, basename(file.path)), "utf8")).toBe(file.content);
    }

    const bridge = await readFile(join(root, "bridge.mjs"), "utf8");
    expect(bridge).not.toBe(
      raw.files.find((file) => basename(file.path) === "bridge.mjs")?.content,
    );
    expect(bridge).toContain("emitAssistantTextFallback");
    expect(bridge).toContain("gatewayModelOverrideSettingsFor");
    expect(result.bridgeDigest).toBe(
      `sha256:${createHash("sha256").update(bridge).digest("hex")}`,
    );
  });

  it("does not leave runtime build-script permissions behind when an install fails", async () => {
    const root = await scratch();
    // A retry must not inherit the runtime-only config from an older attempt.
    await writeFile(join(root, ".npmrc"), "dangerously-allow-all-builds=true\n");
    await expect(installClaudeCodePackRecipe(root, async () => {
      expect(await readdir(root)).not.toContain(".npmrc");
      throw new Error("dependency install failed");
    })).rejects.toThrow("dependency install failed");
    expect(await readdir(root)).not.toContain(".npmrc");

    await installClaudeCodePackRecipe(root, () => {});
    expect(await readFile(join(root, ".npmrc"), "utf8"))
      .toContain("dangerously-allow-all-builds=true");
  });
});
