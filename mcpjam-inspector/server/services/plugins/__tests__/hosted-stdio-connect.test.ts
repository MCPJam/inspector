/**
 * The hosted stdio divert's routing gate: which configured stdio servers it
 * places in a box. The spec read, the box and the runtime are stubbed; what
 * they do is covered by `computer-stdio.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAuthorizedStdioLaunchSpec: vi.fn(),
  resolveColocatedPluginBox: vi.fn(),
  ensurePluginStdioRuntime: vi.fn(),
}));

vi.mock("../../../utils/local-server-resolver.js", () => ({
  createPluginRuntimeConvexClient: vi.fn(() => ({})),
  readAuthorizedStdioLaunchSpec: mocks.readAuthorizedStdioLaunchSpec,
}));
vi.mock("../../../utils/computers/plugin-box.js", () => ({
  e2bPluginBoxConnector: {},
}));
vi.mock("../computer-stdio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../computer-stdio.js")>()),
  canColocatePluginStdio: () => true,
  resolveColocatedPluginBox: mocks.resolveColocatedPluginBox,
  ensurePluginStdioRuntime: mocks.ensurePluginStdioRuntime,
}));

import { resolvePluginStdioHttpTarget } from "../hosted-stdio-connect.js";

const ARGS = {
  bearerToken: "jwt",
  projectId: "project-1",
  serverId: "server-1",
  serverDisplayName: "Fixture",
};
const BOX = { kind: "computer", computerId: "computer-1", sandboxId: "sbx-1" };
const RUNTIME = { url: "https://shim.example/mcp", token: "shim-token" };
// Nothing in this spec says "plugin": no root or data placeholder.
const PLAIN_SPEC = { command: "node", args: ["server.js"], env: {} };

describe("resolvePluginStdioHttpTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveColocatedPluginBox.mockResolvedValue(BOX);
    mocks.ensurePluginStdioRuntime.mockResolvedValue({
      ok: true,
      runtime: RUNTIME,
    });
  });

  it("places a component the backend marks as a plugin's, with no placeholder", async () => {
    mocks.readAuthorizedStdioLaunchSpec.mockResolvedValue({
      ...PLAIN_SPEC,
      pluginComponent: true,
    });
    await expect(resolvePluginStdioHttpTarget(ARGS)).resolves.toEqual(RUNTIME);
    expect(mocks.ensurePluginStdioRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        box: BOX,
        spec: expect.objectContaining({ pluginComponent: true }),
      }),
    );
  });

  it("places a spec that carries the plugin root without the flag", async () => {
    mocks.readAuthorizedStdioLaunchSpec.mockResolvedValue({
      ...PLAIN_SPEC,
      args: ["${PLUGIN_ROOT}/server.js"],
    });
    await expect(resolvePluginStdioHttpTarget(ARGS)).resolves.toEqual(RUNTIME);
  });

  it("leaves an ordinary stdio server refused, without reserving a box", async () => {
    mocks.readAuthorizedStdioLaunchSpec.mockResolvedValue(PLAIN_SPEC);
    await expect(resolvePluginStdioHttpTarget(ARGS)).resolves.toBeNull();
    expect(mocks.resolveColocatedPluginBox).not.toHaveBeenCalled();
    expect(mocks.ensurePluginStdioRuntime).not.toHaveBeenCalled();
  });

  it("refuses a marked component the runtime cannot place", async () => {
    mocks.readAuthorizedStdioLaunchSpec.mockResolvedValue({
      ...PLAIN_SPEC,
      pluginComponent: true,
    });
    mocks.ensurePluginStdioRuntime.mockResolvedValue({
      ok: false,
      reason: "no_plugin_origin",
    });
    await expect(resolvePluginStdioHttpTarget(ARGS)).resolves.toBeNull();
  });
});
