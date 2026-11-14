/**
 * Cursor CLI on the member's computer: its definition against the adapter it
 * pins and the pack recipe, and what the translator does with the ACP
 * bridge's launch (`bridge-launch.ts`) and its private home.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESS_PINNED_VERSIONS } from "@/shared/harness-model-support";
import { CURSOR_CLI_CHECKSUMS } from "../../cursor-bootstrap.js";
import { localCursorBootstrapRecipe } from "../../cursor-local-bridge.js";
import {
  CommandTranslationError,
  classifyBootstrapPath,
  translateAdapterCommand,
  type CommandTranslationContext,
} from "../command-translation.js";
import { cursorLocalRuntime as runtime } from "../runtimes/cursor.js";

const BUNDLE = "/opt/mcpjam/runtimes/cursor";
const LAUNCHER = "/opt/mcpjam/layer/launcher.mjs";
const SESSION = "/home/dev/project";
const HOME = "/home/dev/.mcpjam/harness-local/sessions/s1/home";
const OVERLAY = "/home/dev/.mcpjam/harness-local/sessions/s1/bootstrap";
const BOOT = `${HOME}/.ai-sdk-harness/.harness-bootstrap/cursor`;

const ctx = (platform: NodeJS.Platform = "linux"): CommandTranslationContext => ({
  harnessId: "cursor",
  adapterBootstrapDir: BOOT,
  managedBundleRoot: BUNDLE,
  adapterBootstrapFiles: runtime.manifest.adapterBootstrapFiles,
  bootstrapOverlayDir: OVERLAY,
  nodeExecutable: "/opt/mcpjam/runtimes/cursor/bin/node",
  bridgeLauncherPath: LAUNCHER,
  launcherVendorRoot: BUNDLE,
  sessionRoot: SESSION,
  syntheticHome: HOME,
  platform,
  confine: async (path) => {
    if (!path.startsWith(SESSION) && !path.startsWith(HOME)) throw new Error(`outside granted roots: ${path}`);
    return path;
  },
});

const launch = (flags: Record<string, string>) =>
  `node '${BOOT}/bridge.mjs' ` + Object.entries(flags).map(([flag, value]) => `${flag} '${value}'`).join(" ");
const FLAGS = {
  "--workdir": `${SESSION}/cursor-s1`,
  "--bridge-state-dir": `${HOME}/bridge-state`,
  "--implementation-dir": `${BOOT}/implementation`,
  "--bridge-type": "cursor",
};

describe("the Cursor runtime's definition", () => {
  it("names exactly the bootstrap commands, bridge files and CLI arguments of the adapter it pins", async () => {
    const recipe = await localCursorBootstrapRecipe();
    expect(recipe.bootstrapDir).toBe(runtime.manifest.adapterBootstrapDir);
    expect(recipe.commands.map(({ command }) => command)).toEqual([runtime.commands.install, runtime.commands.versionProbe]);
    for (const name of runtime.layerFiles) expect(recipe.files.some((file) => file.path === `${recipe.bootstrapDir}/${name}`)).toBe(true);
    const descriptor = recipe.files.find((file) => file.path.endsWith("/implementation/implementation.json"));
    const adapterArgs = JSON.parse(String(descriptor?.content)).args as string[];
    expect(runtime.acp!.agent((...segments) => segments.join("/"), "linux").args.slice(-adapterArgs.length)).toEqual(adapterArgs);
    expect(runtime.installedAdapterVersion()).toBe(runtime.manifest.adapterVersion);
  });

  it("starts the CLI with the login in memory and no browser to sign in with, and the adapter with no key", () => {
    expect(runtime.credential.kind).toBe("runtime-login");
    if (runtime.credential.kind !== "runtime-login") return;
    expect(runtime.credential.adapterAuth).toEqual({});
    expect(runtime.credential.childEnv({ accessToken: "login", expiresAt: 0 })).toEqual({
      CURSOR_AUTH_TOKEN: "login",
      AGENT_CLI_CREDENTIAL_STORE: "memory",
      NO_OPEN_BROWSER: "1",
    });
    for (const name of ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "AGENT_CLI_CREDENTIAL_STORE", "NO_OPEN_BROWSER"]) {
      expect(runtime.reservedSecretEnv.test(name)).toBe(true);
    }
  });

  it("pins the same build, and the same archives where hosted Cursor records them", () => {
    const recorded = JSON.parse(
      readFileSync(join(__dirname, "../../../../../scripts/local-harness-pack-recipes/cursor-vendor-checksums.json"), "utf8"),
    ) as { build: string; archives: Record<string, { url: string; sha256: string }> };
    expect(recorded.build).toBe(HARNESS_PINNED_VERSIONS.cursor);
    expect(Object.keys(recorded.archives).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
    for (const archive of Object.values(recorded.archives)) {
      expect(archive.url).toMatch(new RegExp(`^https://downloads\\.cursor\\.com/lab/${recorded.build}/`));
    }
    expect(recorded.archives["linux-x64"]!.sha256).toBe(CURSOR_CLI_CHECKSUMS.x64);
    expect(recorded.archives["linux-arm64"]!.sha256).toBe(CURSOR_CLI_CHECKSUMS.arm64);
  });

  it("bundles the hosted bridge with the local launch change", async () => {
    const bridge = (await localCursorBootstrapRecipe()).files.find((file) => file.path.endsWith("/bridge.mjs"))!.content as string;
    expect(bridge).toContain("? implementation.executablePath : `${implementationDir}/${implementation.executablePath}`");
    expect(bridge).toContain('const mcpTransport = bridgeConfiguration.hostToolMcpTransport ?? "http";');
  });
});

describe("the ACP bridge launch", () => {
  it("starts the bridge with a session descriptor that runs the CLI from the verified pack", async () => {
    const result = await translateAdapterCommand({ command: launch(FLAGS) }, ctx());
    expect(result).toEqual({
      kind: "exec",
      executable: "/opt/mcpjam/runtimes/cursor/bin/node",
      args: [
        LAUNCHER, "--mcpjam-vendor-root", BUNDLE,
        "--workdir", `${SESSION}/cursor-s1`,
        "--bridge-state-dir", `${HOME}/bridge-state`,
        "--implementation-dir", `${OVERLAY}/implementation`,
        "--bridge-type", "cursor",
      ],
      workingDirectory: SESSION,
      files: [{ path: `${OVERLAY}/implementation/implementation.json`, content: expect.any(String) }],
    });
    if (result.kind !== "exec") return;
    const vendor = `${BUNDLE}/node_modules/@anysphere/agent-cli-runtime`;
    expect(JSON.parse(result.files![0]!.content)).toEqual({
      executablePath: `${vendor}/node`,
      args: ["--use-system-ca", `${vendor}/index.js`, "--disable-auto-update", "acp"],
      privateHome: false,
      envKeys: [],
    });
  });

  it("runs Cursor's own node.exe on Windows, as its launcher does", async () => {
    const result = await translateAdapterCommand({ command: launch(FLAGS) }, ctx("win32"));
    if (result.kind !== "exec") throw new Error("expected an exec");
    const descriptor = JSON.parse(result.files![0]!.content) as { executablePath: string; args: string[] };
    expect(descriptor.executablePath).toMatch(/node\.exe$/);
    expect(descriptor.args).not.toContain("--use-system-ca");
  });

  it.each([
    ["another bridge type", { ...FLAGS, "--bridge-type": "codex" }, /--bridge-type must be "cursor"/],
    ["another implementation", { ...FLAGS, "--implementation-dir": `${HOME}/elsewhere` }, /only implementation/],
  ])("refuses %s", async (_label, flags, message) => {
    await expect(translateAdapterCommand({ command: launch(flags) }, ctx())).rejects.toThrow(message);
    await expect(translateAdapterCommand({ command: launch(flags) }, ctx())).rejects.toBeInstanceOf(CommandTranslationError);
  });
});

describe("the CLI's private home in the cloud", () => {
  const cloudHome = `${BOOT}/implementation/home`;

  it("is the session's synthetic home locally, for files and the skills writer alike", async () => {
    expect(classifyBootstrapPath(`${cloudHome}/.agents/skills/.ai-sdk-harness-skills.json`, ctx())).toEqual({
      kind: "session-overlay",
      overlayPath: `${HOME}/.agents/skills/.ai-sdk-harness-skills.json`,
    });
    await expect(
      translateAdapterCommand({ command: `mv -f '${cloudHome}/.agents/.next' '${cloudHome}/.agents/skills'` }, ctx()),
    ).resolves.toEqual({ kind: "rename", from: `${HOME}/.agents/.next`, to: `${HOME}/.agents/skills` });
    await expect(translateAdapterCommand({ command: `mkdir -p '${cloudHome}/.agents'` }, ctx())).resolves.toEqual({
      kind: "mkdir",
      paths: [`${HOME}/.agents`],
    });
  });

  it("still refuses any other file under the bootstrap directory", () => {
    expect(() => classifyBootstrapPath(`${BOOT}/implementation/install.sh`, ctx())).toThrow(/not part of the pinned cursor bootstrap recipe/);
  });
});
