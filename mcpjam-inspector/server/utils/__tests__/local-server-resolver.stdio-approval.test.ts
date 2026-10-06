import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const materializeMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/plugins/local-stdio.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/plugins/local-stdio.js")
  >()),
  materializePluginStdioForConnect: materializeMock,
}));

import {
  resolveLocalServerForConnect,
  resolveLocalStdioServerConfig,
} from "../local-server-resolver.js";
import {
  approveStdioLaunch,
  stdioLaunchFingerprint,
} from "../stdio-command-approvals.js";

const SPEC = { command: "node", args: ["server.js"], env: { FOO: "bar" } };
const fakeContext = { set: () => {}, get: () => undefined } as any;

function localBatchResponse(serverConfig: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      results: {
        "srv-stdio": {
          ok: true,
          role: "owner",
          accessLevel: "project_member",
          permissions: { chatOnly: false },
          serverConfig,
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function stubAuthorize(serverConfig: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return localBatchResponse(serverConfig);
      }
      throw new Error(`Unexpected fetch ${url}`);
    }),
  );
}

describe("stdio command approval gate", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stdio-approval-gate-"));
    vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
    vi.stubEnv("MCPJAM_STDIO_APPROVALS_FILE", join(dir, "approvals.json"));
    materializeMock.mockReset();
    materializeMock.mockResolvedValue(null);
    stubAuthorize({ transportType: "stdio", ...SPEC });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a stdio server this device never approved, naming the command but no env values", async () => {
    const promise = resolveLocalStdioServerConfig(
      "bearer-xyz",
      "proj-1",
      "srv-stdio",
      { serverDisplayName: "Files" },
    );
    await expect(promise).rejects.toMatchObject({
      status: 403,
      code: "STDIO_COMMAND_APPROVAL_REQUIRED",
      details: {
        reason: "stdio_command_approval_required",
        serverId: "srv-stdio",
        approval: {
          serverId: "srv-stdio",
          fingerprint: stdioLaunchFingerprint(SPEC),
          command: "node",
          args: ["server.js"],
          envNames: ["FOO"],
          previouslyApproved: false,
        },
      },
    });
    const error: any = await promise.catch((e) => e);
    expect(JSON.stringify(error.details)).not.toContain("bar");
    expect(error.message).toContain('"Files"');
  });

  it("refuses on the /api/mcp connect path too", async () => {
    await expect(
      resolveLocalServerForConnect(
        fakeContext,
        "bearer-xyz",
        "proj-1",
        "srv-stdio",
        { serverDisplayName: "Files" },
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "STDIO_COMMAND_APPROVAL_REQUIRED",
    });
  });

  it("connects once this device approved the exact command", async () => {
    await approveStdioLaunch("srv-stdio", stdioLaunchFingerprint(SPEC));

    const config: any = await resolveLocalStdioServerConfig(
      "bearer-xyz",
      "proj-1",
      "srv-stdio",
    );
    expect(config).toMatchObject(SPEC);

    const { config: connectConfig }: any = await resolveLocalServerForConnect(
      fakeContext,
      "bearer-xyz",
      "proj-1",
      "srv-stdio",
      { serverDisplayName: "Files" },
    );
    expect(connectConfig).toMatchObject(SPEC);
  });

  it("asks again when the command changed since this device approved it", async () => {
    await approveStdioLaunch(
      "srv-stdio",
      stdioLaunchFingerprint({ ...SPEC, args: ["old.js"] }),
    );

    await expect(
      resolveLocalStdioServerConfig("bearer-xyz", "proj-1", "srv-stdio"),
    ).rejects.toMatchObject({
      status: 403,
      details: { approval: { args: ["server.js"], previouslyApproved: true } },
    });
  });

  it("fingerprints the revealed env, so a changed secret value asks again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        const url = String(input);
        if (url.endsWith("/web/authorize-batch-local")) {
          return localBatchResponse({
            transportType: "stdio",
            command: "node",
            args: ["server.js"],
            env: {},
            hasEnv: true,
          });
        }
        if (url.endsWith("/web/server/reveal-secrets")) {
          return new Response(
            JSON.stringify({
              success: true,
              env: { TOKEN: "revealed" },
              headers: null,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch ${url}`);
      }),
    );
    await approveStdioLaunch(
      "srv-stdio",
      stdioLaunchFingerprint({
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "previous" },
      }),
    );

    const promise = resolveLocalStdioServerConfig(
      "bearer-xyz",
      "proj-1",
      "srv-stdio",
    );
    await expect(promise).rejects.toMatchObject({
      status: 403,
      details: {
        approval: {
          envNames: ["TOKEN"],
          previouslyApproved: true,
          fingerprint: stdioLaunchFingerprint({
            command: "node",
            args: ["server.js"],
            env: { TOKEN: "revealed" },
          }),
        },
      },
    });
    const error: any = await promise.catch((e) => e);
    expect(JSON.stringify(error.details)).not.toContain("revealed");
  });

  it("does not gate a plugin component, whose bundle is verified at materialization", async () => {
    stubAuthorize({
      transportType: "stdio",
      command: "node",
      args: ["${PLUGIN_ROOT}/server/index.js"],
      env: {},
    });
    materializeMock.mockResolvedValue({
      command: "node",
      args: ["/cache/bundle/server/index.js"],
      env: {},
      pluginRoot: "/cache/bundle",
      origin: { pluginId: "plugin-1", bundleHash: "hash-1" },
    });

    const config: any = await resolveLocalStdioServerConfig(
      "bearer-xyz",
      "proj-1",
      "srv-stdio",
    );
    expect(config.args).toEqual(["/cache/bundle/server/index.js"]);
  });
});
