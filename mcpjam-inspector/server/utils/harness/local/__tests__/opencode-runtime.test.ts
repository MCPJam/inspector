/**
 * OpenCode on the member's computer: its definition against the adapter it
 * pins and the pack recipe, the local launch changes to the adapter's bridge,
 * and what the translator does with the bridge's launch (`bridge-launch.ts`).
 */
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESS_PINNED_VERSIONS } from "@/shared/harness-model-support";
import { localOpenCodeBootstrapRecipe, patchOpenCodeLocalLaunch } from "../../opencode-local-bridge.js";
import { vendorPins } from "../../../../../scripts/local-harness-pack-recipes/opencode.mjs";
import {
  CommandTranslationError,
  translateAdapterCommand,
  type CommandTranslationContext,
} from "../command-translation.js";
import { opencodeLocalRuntime as runtime } from "../runtimes/opencode.js";

// The pack and the layer are the host's own paths (`resolve` gives them a drive
// on Windows); the adapter's grammar is POSIX on every host.
const BUNDLE = resolve("/opt/mcpjam/runtimes/opencode");
const LAYER = resolve("/opt/mcpjam/layer");
const SESSION = "/home/dev/project";
const STATE = "/home/dev/.mcpjam/harness-local-sessions/s1";
const HOME = `${STATE}/home`;
const BOOT = `${HOME}/.ai-sdk-harness/.harness-bootstrap/opencode`;
const RECIPES = join(__dirname, "../../../../../scripts/local-harness-pack-recipes");

const ctx: CommandTranslationContext = {
  harnessId: "opencode",
  adapterBootstrapDir: BOOT,
  managedBundleRoot: BUNDLE,
  layerRoot: LAYER,
  layerFiles: runtime.layerFiles,
  launcherVendorRoot: BUNDLE,
  adapterBootstrapFiles: runtime.manifest.adapterBootstrapFiles,
  bootstrapOverlayDir: `${STATE}/bootstrap`,
  nodeExecutable: `${BUNDLE}/bin/node`,
  bridgeLauncherPath: `${LAYER}/launcher.mjs`,
  sessionRoot: SESSION,
  syntheticHome: HOME,
  confine: async (path) => {
    if (!path.startsWith(SESSION) && !path.startsWith(STATE)) throw new Error(`outside granted roots: ${path}`);
    return path;
  },
  confineToSessionState: async (path) => {
    if (!path.startsWith(STATE)) throw new Error(`outside session state: ${path}`);
    return path;
  },
};

const launch = (flags: Record<string, string>) =>
  `node '${BOOT}/bridge.mjs' ` + Object.entries(flags).map(([flag, value]) => `${flag} '${value}'`).join(" ");
const FLAGS = {
  "--workdir": SESSION,
  "--bridge-state-dir": `${HOME}/.ai-sdk-harness/.agent-runs/s1/bridge`,
  "--bootstrap-dir": BOOT,
  "--skills-dir": `${HOME}/.agents/skills`,
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const bridgeOf = async () =>
  (await localOpenCodeBootstrapRecipe()).files.find((file) => file.path.endsWith("/bridge.mjs"))!.content as string;

describe("the OpenCode runtime's definition", () => {
  it("names exactly the bootstrap commands and bridge files of the adapter it pins", async () => {
    const recipe = await localOpenCodeBootstrapRecipe();
    expect(recipe.bootstrapDir).toBe(runtime.manifest.adapterBootstrapDir);
    expect(recipe.commands.map(({ command }) => command)).toEqual([runtime.commands.install, runtime.commands.versionProbe]);
    for (const name of runtime.layerFiles) expect(recipe.files.some((file) => file.path === `${recipe.bootstrapDir}/${name}`)).toBe(true);
    expect(runtime.installedAdapterVersion()).toBe(runtime.manifest.adapterVersion);
  });

  it("hands the CLI the gateway's capability as its Anthropic token, at the gateway's /v1", () => {
    expect(runtime.credential.kind).toBe("gateway");
    if (runtime.credential.kind !== "gateway") return;
    expect(runtime.credential.childAuth({ baseUrl: "http://127.0.0.1:4100", sessionCapability: "cap" })).toEqual({
      ANTHROPIC_AUTH_TOKEN: "cap",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4100/v1",
    });
    for (const name of [...runtime.bridgeEnv, "OPENCODE_CONFIG", "OPENCODE_PERMISSION", "OPENAI_NAME", "AI_GATEWAY_BASE_URL"]) {
      expect(runtime.reservedSecretEnv.test(name)).toBe(true);
    }
  });

  it("pins the build hosted OpenCode runs, and the versions the adapter's bridge expects", async () => {
    const pins = vendorPins();
    const adapter = JSON.parse(
      (await localOpenCodeBootstrapRecipe()).files.find((file) => file.path.endsWith("/package.json"))!.content as string,
    ).dependencies as Record<string, string>;
    for (const build of ["opencode-darwin-arm64", "opencode-darwin-x64", "opencode-linux-arm64", "opencode-linux-x64", "opencode-windows-x64"]) {
      expect(pins[build]).toBe(HARNESS_PINNED_VERSIONS.opencode);
    }
    expect(adapter["opencode-ai"]).toBe(HARNESS_PINNED_VERSIONS.opencode);
    expect(pins["@opencode-ai/sdk"]).toBe(adapter["@opencode-ai/sdk"]);
    expect(pins["@vscode/ripgrep"]).toBe(adapter["@vscode/ripgrep"]);
  });

  it("records every target's two builds, from the tarballs the lockfile installs", () => {
    const recorded = JSON.parse(readFileSync(join(RECIPES, "opencode-vendor-checksums.json"), "utf8")) as Record<
      string,
      Record<string, { spec: string; integrity: string }>
    >;
    const lockfile = readFileSync(join(RECIPES, "opencode-vendor/pnpm-lock.yaml"), "utf8");
    expect(Object.keys(recorded).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
    for (const builds of Object.values(recorded)) {
      expect(Object.keys(builds)).toHaveLength(2);
      for (const { spec, integrity } of Object.values(builds)) {
        // pnpm quotes a scoped name and leaves a bare one as it is.
        const entry = new RegExp(`\\n  '?${escapeRegExp(spec)}'?:\\n    resolution: \\{integrity: ${escapeRegExp(integrity)}\\}`);
        expect(lockfile).toMatch(entry);
      }
    }
  });

  it("checks each target's own build answers --version", () => {
    expect(runtime.vendorProbe({ target: "win32-x64", platform: "win32" })).toEqual({
      run: { binary: ["node_modules", "opencode-windows-x64", "bin", "opencode.exe"] },
      args: ["--version"],
      version: { from: "package-json", path: ["node_modules", "opencode-windows-x64", "package.json"] },
    });
    expect(runtime.vendorProbe({ target: "darwin-arm64", platform: "darwin" }).run).toEqual({
      binary: ["node_modules", "opencode-darwin-arm64", "bin", "opencode"],
    });
  });
});

describe("the bridge a local session runs", () => {
  it("finds the CLI in the pack and starts the host-tool entrypoint from the layer with the pack's Node", async () => {
    const bridge = await bridgeOf();
    expect(bridge).toContain('path.join(vendorDir, "node_modules", build, "bin"), env.PATH || fallbackPath, path.dirname(rgPath)');
    expect(bridge).toContain("command: [process.execPath, `${mcpjamLayerDir}/host-tool-mcp.mjs`],");
    expect(bridge).not.toContain("configureOpenCodePath({\n\tbootstrapDir,");
    expect(patchOpenCodeLocalLaunch(bridge)).toBe(bridge);
  });

  it("refuses a bridge whose launch code moved", async () => {
    const hosted = (await bridgeOf()).replace("command: [process.execPath, `${mcpjamLayerDir}/host-tool-mcp.mjs`],", "command: [\"bun\"],");
    expect(() => patchOpenCodeLocalLaunch(hosted)).toThrow(/anchor changed/);
  });
});

describe("the OpenCode bridge launch", () => {
  it("names the pack and the layer for the bootstrap directory, and keeps state in the session's own directory", async () => {
    const result = await translateAdapterCommand({ command: launch(FLAGS) }, ctx);
    expect(result).toEqual({
      kind: "exec",
      executable: `${BUNDLE}/bin/node`,
      args: [
        `${LAYER}/launcher.mjs`, "--mcpjam-vendor-root", BUNDLE,
        "--workdir", SESSION,
        "--bridge-state-dir", `${HOME}/.ai-sdk-harness/.agent-runs/s1/bridge`,
        "--vendor-dir", BUNDLE, "--layer-dir", LAYER,
        "--skills-dir", `${HOME}/.agents/skills`,
      ],
      workingDirectory: SESSION,
    });
    expect(result.kind === "exec" && result.args.every((arg) => !arg.includes(`${sep}..`))).toBe(true);
  });

  it.each([
    ["another bootstrap directory", { ...FLAGS, "--bootstrap-dir": `${HOME}/elsewhere` }, /only bootstrap/],
    ["a skills folder in the workspace", { ...FLAGS, "--skills-dir": `${SESSION}/.agents/skills` }, /outside session state/],
  ])("refuses %s", async (_label, flags, message) => {
    await expect(translateAdapterCommand({ command: launch(flags) }, ctx)).rejects.toThrow(message);
  });

  it("refuses a launch missing a flag the pinned adapter sends", async () => {
    const { "--skills-dir": _skills, ...rest } = FLAGS;
    await expect(translateAdapterCommand({ command: launch(rest) }, ctx)).rejects.toBeInstanceOf(CommandTranslationError);
  });
});
