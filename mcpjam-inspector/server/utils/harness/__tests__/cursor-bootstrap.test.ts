import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessV1SandboxProvider } from "@ai-sdk/harness";
import { HarnessAgent, type HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { HARNESS_PINNED_VERSIONS } from "@/shared/harness-model-support";
import {
  CURSOR_CLI_CHECKSUMS,
  CURSOR_CLI_VERSION,
  cursorCliDownloadUrl,
  pinCursorHarnessBootstrap,
  renderPinnedCursorInstallScript,
} from "../cursor-bootstrap.js";
import { getHarnessAdapter } from "../registry.js";
import { harnessRecipeIdentity } from "../harness-bake.js";

type CreateHarness = (args: unknown) => HarnessAgentAdapter;
const createCursor = () =>
  (getHarnessAdapter("cursor").createHarness as unknown as CreateHarness)({
    auth: { CURSOR_API_KEY: "x" },
    mcpJson: { mcpServers: {} },
  });

describe("the pinned Cursor CLI", () => {
  it("is the version the shared evidence table pins, in the shape Cursor stamps", () => {
    expect(CURSOR_CLI_VERSION).toBe(HARNESS_PINNED_VERSIONS.cursor);
    expect(CURSOR_CLI_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7,}$/);
  });

  it("records a SHA-256 for each architecture the template builds for", () => {
    for (const checksum of Object.values(CURSOR_CLI_CHECKSUMS)) {
      expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(CURSOR_CLI_CHECKSUMS.x64).not.toBe(CURSOR_CLI_CHECKSUMS.arm64);
  });

  it("downloads from where Cursor's own installer does", () => {
    expect(cursorCliDownloadUrl("x64")).toBe(
      `https://downloads.cursor.com/lab/${CURSOR_CLI_VERSION}/linux/x64/agent-cli-package.tar.gz`,
    );
  });

  describe("the installer script", () => {
    const script = renderPinnedCursorInstallScript();

    it("is deterministic, so the recipe identity (and the baked marker) is stable", () => {
      expect(renderPinnedCursorInstallScript()).toBe(script);
    });

    it("checks the archive's SHA-256 before it extracts anything", () => {
      expect(script).toContain(CURSOR_CLI_CHECKSUMS.x64);
      expect(script).toContain(CURSOR_CLI_CHECKSUMS.arm64);
      expect(script).toContain("set -euo pipefail");
      const verify = script.indexOf("sha256sum -c -");
      const extract = script.indexOf("tar --strip-components=1");
      expect(verify).toBeGreaterThan(-1);
      expect(extract).toBeGreaterThan(verify);
    });

    it("pins the build, refuses an unknown architecture, and never pipes the web into a shell", () => {
      expect(script).toContain(`CURSOR_VERSION="${CURSOR_CLI_VERSION}"`);
      expect(script).toContain("unsupported architecture");
      expect(script).not.toMatch(/cursor\.com\/install/);
      expect(script).not.toMatch(/\|\s*(ba)?sh\b/);
    });

    it("leaves the layout the adapter's implementation.json expects", () => {
      // `executablePath: home/.local/bin/agent`, under the private HOME.
      expect(script).toContain(
        'ACP_INSTALL_HOME="$ACP_IMPLEMENTATION_DIR/home"',
      );
      expect(script).toContain('"$ACP_INSTALL_HOME/.local/bin/agent"');
      expect(script).toContain(
        ".local/share/cursor-agent/versions/${CURSOR_VERSION}",
      );
    });

    it("fails the install unless the installed CLI reports the pinned build", () => {
      expect(script).toMatch(
        /test "\$\(.*--version\)" = "\$\{CURSOR_VERSION\}"/,
      );
    });
  });
});

describe("the hosted Cursor adapter", () => {
  it("bootstraps with the pinned installer instead of the vendor's curl | bash", async () => {
    const bootstrap = await createCursor().getBootstrap!();
    const install = bootstrap.files.find((file) =>
      file.path.endsWith("/implementation/install.sh"),
    );
    expect(install?.content).toBe(renderPinnedCursorInstallScript());
    // The rest of the vendor recipe is untouched.
    expect(bootstrap.commands.map((c) => c.command)).toContain(
      "bash implementation/install.sh",
    );
    expect(
      bootstrap.files.some((file) => file.path.endsWith("/bridge.mjs")),
    ).toBe(true);
  });

  it("has a stable recipe identity, whatever credential the turn carries", async () => {
    const a = harnessRecipeIdentity(await createCursor().getBootstrap!());
    const b = harnessRecipeIdentity(
      await (
        getHarnessAdapter("cursor").createHarness as unknown as CreateHarness
      )({
        auth: { CURSOR_API_KEY: "another" },
        mcpJson: { mcpServers: {} },
      }).getBootstrap!(),
    );
    expect(a).toBe(b);
  });

  it("builds the bootstrap once", async () => {
    const harness = createCursor();
    expect(await harness.getBootstrap!()).toBe(await harness.getBootstrap!());
  });
});

// The framework copy Inspector runs installs the recipe, and the adapter's own
// framework copy decides where to launch the bridge from. When the two
// disagree, the bridge is missing at turn time, so the probe runs both
// against one sandbox and compares the directories they actually use.
describe("the hosted Cursor bridge", () => {
  const STOP = "stop-at-bridge-spawn";
  // Deliberately not HOME: an adapter that resolves its bridge against HOME
  // must fail this check even on a box where the two happen to coincide.
  const DEFAULT_DIR = "/home/user/work";

  async function launchLayout() {
    const written: string[] = [];
    const spawned: string[] = [];
    const session = {
      id: "bridge-layout-probe",
      defaultWorkingDirectory: DEFAULT_DIR,
      description: "bridge layout probe",
      ports: [39271],
      readTextFile: async () => null,
      readBinaryFile: async () => null,
      readFile: async () => null,
      writeTextFile: async ({ path }: { path: string }) => {
        written.push(path);
      },
      writeBinaryFile: async () => {},
      writeFile: async () => {},
      run: async ({ command }: { command: string }) => ({
        exitCode: 0,
        stdout: command.includes("$HOME") ? "/home/user" : "",
        stderr: "",
      }),
      spawn: async ({ command }: { command: string }) => {
        spawned.push(command);
        throw new Error(STOP);
      },
      getPortEndpoint: async () => ({ url: "ws://127.0.0.1:1" }),
      getPortUrl: async () => "ws://127.0.0.1:1",
      stop: async () => {},
      destroy: async () => {},
      restricted: () => session,
    };
    const provider: HarnessV1SandboxProvider = {
      specificationVersion: "harness-sandbox-v1",
      providerId: "bridge-layout-probe",
      createSession: async () => session as never,
    };
    const harness = createCursor();
    const agent = new HarnessAgent({ harness, sandbox: provider } as never);
    await expect(agent.createSession()).rejects.toThrow(STOP);
    return { recipe: await harness.getBootstrap!(), written, spawned };
  }

  it("launches from the directory the framework installed the recipe into", async () => {
    const { recipe, written, spawned } = await launchLayout();
    const installed = written.find((path) => path.endsWith("/bridge.mjs"));
    const launched = /^node '([^']+)\/bridge\.mjs'/.exec(spawned[0] ?? "")?.[1];
    expect(installed).toBeDefined();
    expect(launched).toBeDefined();
    expect(launched).toBe(posix.dirname(installed!));
    expect(launched).toBe(posix.join(DEFAULT_DIR, recipe.bootstrapDir));
  });
});

describe("pinCursorHarnessBootstrap", () => {
  const recipe = (installPath: string) => ({
    harnessId: "cursor",
    bootstrapDir: ".harness-bootstrap/cursor",
    files: [
      { path: ".harness-bootstrap/cursor/bridge.mjs", content: "bridge" },
      { path: installPath, content: "curl https://cursor.com/install | bash" },
    ],
    commands: [{ command: "bash implementation/install.sh" }],
  });
  const adapter = (bootstrap: unknown) =>
    ({ getBootstrap: async () => bootstrap }) as unknown as HarnessAgentAdapter;

  it("replaces only the installer", async () => {
    const pinned = await pinCursorHarnessBootstrap(
      adapter(recipe(".harness-bootstrap/cursor/implementation/install.sh")),
    ).getBootstrap!();
    expect(pinned.files).toEqual([
      { path: ".harness-bootstrap/cursor/bridge.mjs", content: "bridge" },
      {
        path: ".harness-bootstrap/cursor/implementation/install.sh",
        content: renderPinnedCursorInstallScript(),
      },
    ]);
  });

  it("refuses, rather than ship the unpinned install, when the vendor moves the installer", async () => {
    await expect(
      pinCursorHarnessBootstrap(
        adapter(recipe(".harness-bootstrap/cursor/implementation/setup.sh")),
      ).getBootstrap!(),
    ).rejects.toThrow(/no longer ships implementation\/install\.sh/);
  });

  it("passes an adapter with no bootstrap straight through", () => {
    const bare = {} as HarnessAgentAdapter;
    expect(pinCursorHarnessBootstrap(bare)).toBe(bare);
  });
});
