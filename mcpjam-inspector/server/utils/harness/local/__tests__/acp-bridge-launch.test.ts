/**
 * A runtime started through the AI SDK's ACP bridge (`LocalRuntime.acp`), on
 * a stand-in definition: the bridge launch gets a session implementation
 * descriptor that starts the CLI from the verified pack, a literal flag passes
 * only as itself, and the CLI's cloud private home is the synthetic home.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../runtimes/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../runtimes/index.js")>();
  const base = real.localRuntime("claude-code");
  const acpRuntime = {
    ...base,
    commands: {
      ...base.commands,
      bridgeFlags: ["--workdir", "--bridge-state-dir", "--implementation-dir", "--bridge-type"],
      sessionStateFlags: ["--bridge-state-dir"],
      literalFlags: { "--bridge-type": "stand-in" },
    },
    acp: {
      implementationDirFlag: "--implementation-dir",
      agent: (inPack: (...segments: string[]) => string, platform: NodeJS.Platform) => ({
        executable: inPack("vendor", platform === "win32" ? "node.exe" : "node"),
        args: [inPack("vendor", "cli.js"), "acp"],
      }),
    },
  };
  return { ...real, localRuntime: () => acpRuntime, localRuntimeOf: () => acpRuntime };
});

const { CommandTranslationError, classifyBootstrapPath, translateAdapterCommand } = await import("../command-translation.js");
type Context = import("../command-translation.js").CommandTranslationContext;

const BUNDLE = "/opt/mcpjam/runtimes/stand-in";
const LAUNCHER = "/opt/mcpjam/layer/launcher.mjs";
const SESSION = "/home/dev/project";
const HOME = "/home/dev/.mcpjam/harness-local/sessions/s1/home";
const OVERLAY = "/home/dev/.mcpjam/harness-local/sessions/s1/bootstrap";
const BOOT = `${HOME}/.ai-sdk-harness/.harness-bootstrap/claude-code`;

const ctx = (platform: NodeJS.Platform = "linux"): Context => ({
  harnessId: "claude-code",
  adapterBootstrapDir: BOOT,
  managedBundleRoot: BUNDLE,
  adapterBootstrapFiles: ["bridge.mjs"],
  bootstrapOverlayDir: OVERLAY,
  nodeExecutable: `${BUNDLE}/bin/node`,
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

const FLAGS = {
  "--workdir": `${SESSION}/work`,
  "--bridge-state-dir": `${HOME}/bridge-state`,
  "--implementation-dir": `${BOOT}/implementation`,
  "--bridge-type": "stand-in",
};
const launch = (flags: Record<string, string>) =>
  `node '${BOOT}/bridge.mjs' ` + Object.entries(flags).map(([flag, value]) => `${flag} '${value}'`).join(" ");

describe("an ACP bridge launch", () => {
  it("points the bridge at a session descriptor that starts the CLI from the verified pack", async () => {
    const result = await translateAdapterCommand({ command: launch(FLAGS) }, ctx());
    expect(result).toEqual({
      kind: "exec",
      executable: `${BUNDLE}/bin/node`,
      args: [
        LAUNCHER, "--mcpjam-vendor-root", BUNDLE,
        "--workdir", `${SESSION}/work`,
        "--bridge-state-dir", `${HOME}/bridge-state`,
        "--implementation-dir", `${OVERLAY}/implementation`,
        "--bridge-type", "stand-in",
      ],
      workingDirectory: SESSION,
      files: [{ path: `${OVERLAY}/implementation/implementation.json`, content: expect.any(String) }],
    });
    if (result.kind !== "exec") return;
    expect(JSON.parse(result.files![0]!.content)).toEqual({
      executablePath: `${BUNDLE}/vendor/node`,
      args: [`${BUNDLE}/vendor/cli.js`, "acp"],
      privateHome: false,
      envKeys: [],
    });
  });

  it("asks the definition for the platform's executable", async () => {
    const result = await translateAdapterCommand({ command: launch(FLAGS) }, ctx("win32"));
    if (result.kind !== "exec") throw new Error("expected an exec");
    expect(JSON.parse(result.files![0]!.content).executablePath).toMatch(/node\.exe$/);
  });

  it.each([
    ["a literal flag with another value", { ...FLAGS, "--bridge-type": "other" }, /--bridge-type must be "stand-in"/],
    ["another implementation directory", { ...FLAGS, "--implementation-dir": `${HOME}/elsewhere` }, /only implementation/],
  ])("refuses %s", async (_label, flags, message) => {
    const attempt = translateAdapterCommand({ command: launch(flags) }, ctx());
    await expect(attempt).rejects.toThrow(message);
    await expect(attempt).rejects.toBeInstanceOf(CommandTranslationError);
  });
});

describe("the CLI's private home in the cloud", () => {
  const cloudHome = `${BOOT}/implementation/home`;

  it("is the session's synthetic home, for files and the skills writer alike", async () => {
    expect(classifyBootstrapPath(`${cloudHome}/.agents/skills/manifest.json`, ctx())).toEqual({
      kind: "session-overlay",
      overlayPath: `${HOME}/.agents/skills/manifest.json`,
    });
    await expect(
      translateAdapterCommand({ command: `mv -f '${cloudHome}/.agents/.next' '${cloudHome}/.agents/skills'` }, ctx()),
    ).resolves.toEqual({ kind: "rename", from: `${HOME}/.agents/.next`, to: `${HOME}/.agents/skills` });
    await expect(translateAdapterCommand({ command: `test ! -e '${cloudHome}/.agents/skills'` }, ctx())).resolves.toEqual({
      kind: "probe-absent",
      path: `${HOME}/.agents/skills`,
    });
    await expect(translateAdapterCommand({ command: `rm -rf -- '${cloudHome}/.agents/old'` }, ctx())).resolves.toEqual({
      kind: "remove",
      paths: [`${HOME}/.agents/old`],
    });
    await expect(translateAdapterCommand({ command: `mkdir -p '${cloudHome}/.agents'` }, ctx())).resolves.toEqual({
      kind: "mkdir",
      paths: [`${HOME}/.agents`],
    });
  });

  it("leaves every other bootstrap file closed", () => {
    expect(() => classifyBootstrapPath(`${BOOT}/implementation/install.sh`, ctx())).toThrow(/not part of the pinned/);
  });
});
