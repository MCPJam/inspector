import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockMcpClientManager, createTestApp } from "./helpers/index.js";
import {
  readStdioLaunchApproval,
  stdioLaunchFingerprint,
} from "../../../utils/stdio-command-approvals.js";

vi.mock("../../../services/rpc-log-bus", () => ({
  rpcLogBus: {
    getBuffer: vi.fn().mockReturnValue([]),
    subscribe: vi.fn().mockReturnValue(() => {}),
    forgetServer: vi.fn(),
  },
}));

const PROJECT_ID = "proj_approve";
const SERVER_ID = "srv_approve";
const SPEC = { command: "node", args: ["server.js"], env: { FOO: "bar" } };
const FINGERPRINT = stdioLaunchFingerprint(SPEC);

function headers(withBearer = true) {
  return {
    "Content-Type": "application/json",
    ...(withBearer ? { Authorization: "Bearer guest-bearer-test" } : {}),
  };
}

function stubAuthorize(serverConfig: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return new Response(
          JSON.stringify({
            results: {
              [SERVER_ID]: {
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
      throw new Error(`Unexpected fetch ${url}`);
    }),
  );
}

describe("POST /api/mcp/servers/approve-command", () => {
  let app: Hono;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "approve-command-"));
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
    vi.stubEnv("MCPJAM_STDIO_APPROVALS_FILE", join(dir, "approvals.json"));
    app = createTestApp(createMockMcpClientManager(), "servers");
    stubAuthorize({ transportType: "stdio", ...SPEC });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (body: Record<string, unknown>, withBearer = true) =>
    app.request("/api/mcp/servers/approve-command", {
      method: "POST",
      headers: headers(withBearer),
      body: JSON.stringify(body),
    });

  const validBody = {
    projectId: PROJECT_ID,
    serverId: SERVER_ID,
    serverName: "Files",
    fingerprint: FINGERPRINT,
  };

  it("returns 400 without a fingerprint", async () => {
    const res = await post({ ...validBody, fingerprint: undefined });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false });
    expect(await readStdioLaunchApproval(SERVER_ID, FINGERPRINT)).toBe("none");
  });

  it("returns 401 without a bearer", async () => {
    const res = await post(validBody, false);
    expect(res.status).toBe(401);
    expect(await readStdioLaunchApproval(SERVER_ID, FINGERPRINT)).toBe("none");
  });

  it("records the approval when the fingerprint still matches the stored command", async () => {
    const res = await post(validBody);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      fingerprint: FINGERPRINT,
    });
    expect(await readStdioLaunchApproval(SERVER_ID, FINGERPRINT)).toBe(
      "approved",
    );
  });

  it("returns 409 with the current terms when the command moved since the dialog was shown", async () => {
    stubAuthorize({ transportType: "stdio", ...SPEC, args: ["other.js"] });

    const res = await post(validBody);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      reason: "stdio_command_approval_required",
      serverId: SERVER_ID,
      approval: {
        serverId: SERVER_ID,
        fingerprint: stdioLaunchFingerprint({ ...SPEC, args: ["other.js"] }),
        command: "node",
        args: ["other.js"],
        envNames: ["FOO"],
        previouslyApproved: false,
      },
    });
    expect(JSON.stringify(body)).not.toContain("bar");
    expect(await readStdioLaunchApproval(SERVER_ID, FINGERPRINT)).toBe("none");
  });

  it("refuses to approve an http server", async () => {
    stubAuthorize({
      transportType: "http",
      url: "https://hosted.example.com/mcp",
      headers: {},
    });

    const res = await post(validBody);
    expect(res.status).toBe(409);
    expect(await readStdioLaunchApproval(SERVER_ID, FINGERPRINT)).toBe("none");
  });
});
