import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withLocalRuntimeBootstrap } from "../pack-bootstrap.js";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createClaudeCodeHarness } from "../../claude-code-bootstrap.js";
import { getCodexAppServerBootstrap } from "../../codex-appserver/codex-appserver-bootstrap.js";
import { LOCAL_HARNESS_MANIFEST } from "../compatibility.js";
import { inspectorLayerDigest, inspectorLayerFiles } from "../inspector-layer.js";
import {
  stageRecipe as installClaudeCodePackRecipe,
  vendorSdkVersion,
} from "../../../../../scripts/local-harness-pack-recipes/claude-code.mjs";

/** The committed manifest the recipe installs the Claude Code vendor graph from. */
const VENDOR_MANIFEST = fileURLToPath(
  new URL("../../../../../scripts/local-harness-pack-recipes/claude-code-vendor/package.json", import.meta.url),
);

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

/** A layered runtime, as resolution hands one to the turn path. */
const layered = (harnessId: "claude-code" | "codex") => ({
  harnessId,
  rootPath: "/runtime/pack",
  layer: { root: "/runtime/inspector-layer/x", digest: inspectorLayerDigest(harnessId)!, files: [] },
});

/** An adapter that cannot read its own package — a packaged Electron app. */
const unreadable = <T extends object>(adapter: T) => ({
  ...adapter,
  getBootstrap: async () => {
    throw new Error("No node_modules in packaged Electron");
  },
});

describe("the Claude Code pack is vendor bytes only", () => {
  it("installs from the committed vendor manifest, then keeps none of it", async () => {
    const root = await scratch();
    let installed = false;
    const result = await installClaudeCodePackRecipe(root, async () => {
      // Exactly the vendor graph's manifest and lockfile — no bridge, no
      // adapter recipe, no build-script permissions.
      expect((await readdir(root)).sort()).toEqual(["package.json", "pnpm-lock.yaml"]);
      // The committed vendor graph, exactly: the agent SDK and its declared
      // peers. (Compared with the file rather than spelled out here: the MCP
      // SDK peer's name is one the runtime-imports guard refuses in server code.)
      const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      const vendor = JSON.parse(await readFile(VENDOR_MANIFEST, "utf8"));
      expect(pkg.dependencies).toEqual(vendor.dependencies);
      const names = Object.keys(pkg.dependencies);
      expect(names).toHaveLength(4);
      expect(names).toEqual(expect.arrayContaining(["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/sdk", "zod"]));
      for (const bridgeOnly of ["ws", "@ai-sdk/harness-claude-code", "esbuild"]) expect(names).not.toContain(bridgeOnly);
      installed = true;
    });
    expect(installed).toBe(true);
    expect(await readdir(root)).toEqual([]);
    expect(result).toEqual({});
  });

  it("pins the agent SDK the adapter's bridge was written against", async () => {
    // The bridge's one external import resolves into the pack, so the two must
    // agree. The layer bundler refuses to build otherwise; this pins it too.
    const raw = await createClaudeCode().getBootstrap!();
    const adapterPackage = JSON.parse(
      raw.files.find((file) => basename(file.path) === "package.json")!.content,
    );
    expect(adapterPackage.dependencies["@anthropic-ai/claude-agent-sdk"]).toBe(vendorSdkVersion());
  });
});

describe("a local session's recipe comes from the Inspector layer", () => {
  it("is the PATCHED Claude Code bridge, bundled, with the adapter's commands", async () => {
    const runtime = await createClaudeCodeHarness().getBootstrap!();
    const bundled = await withLocalRuntimeBootstrap(unreadable(createClaudeCodeHarness()), layered("claude-code"));
    const recipe = await bundled.getBootstrap!();
    expect(recipe.bootstrapDir).toBe(runtime.bootstrapDir);
    expect(recipe.commands).toEqual(runtime.commands);
    expect(recipe.files.map((file) => basename(file.path))).toEqual(["bridge.mjs"]);
    expect([...LOCAL_HARNESS_MANIFEST["claude-code"].adapterBootstrapFiles]).toEqual(["bridge.mjs"]);

    const bridge = recipe.files[0]!.content;
    expect(bridge).toBe(inspectorLayerFiles("claude-code")!.find((file) => file.path === "bridge.mjs")!.content);
    // Patched, not the adapter's verbatim bridge…
    expect(bridge).toContain("emitAssistantTextFallback");
    expect(bridge).toContain("gatewayModelOverrideSettingsFor");
    // …with its own dependencies compiled in and the agent SDK left to the pack.
    expect(bridge).toMatch(/from\s*"@anthropic-ai\/claude-agent-sdk"/);
    expect(bridge).not.toMatch(/from\s*"(ws|zod|zod\/v4|@modelcontextprotocol\/sdk[^"]*)"/);
  });

  it("is Codex's layer bridge and entrypoint with the app-server recipe's commands", async () => {
    const upstream = getCodexAppServerBootstrap();
    const bundled = await withLocalRuntimeBootstrap(unreadable({ id: "codex" } as never), layered("codex"));
    const recipe = await bundled.getBootstrap!();
    expect(recipe.bootstrapDir).toBe(upstream.bootstrapDir);
    expect(recipe.commands).toEqual(upstream.commands);
    expect(recipe.files.map((file) => basename(file.path)).sort()).toEqual(["bridge.mjs", "host-tools-mcp.mjs"]);
  });
});
