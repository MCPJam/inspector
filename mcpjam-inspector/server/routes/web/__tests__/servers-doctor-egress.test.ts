import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The hosted doctor dials its target twice: the probe, which goes through the
 * egress-guarded fetch, and the connection step, which goes out over an MCP
 * transport that takes no fetch at all. `runServerDoctor` records a failed
 * probe and connects regardless, so guarding only the probe left the second
 * dial reaching whatever the first one was refused. The route therefore judges
 * the target before either step runs.
 */

const { runServerDoctorMock } = vi.hoisted(() => ({
  runServerDoctorMock: vi.fn(),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk"
  );
  return { ...actual, runServerDoctor: runServerDoctorMock };
});

const serverUrlRef = { current: "https://mcp.example.test/mcp" };

async function postDoctor() {
  const { default: serversRoutes } = await import("../servers.js");
  const app = new Hono();
  app.route("/api/web/servers", serversRoutes);
  return app.request("/api/web/servers/doctor", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({ projectId: "p1", serverId: "s1" }),
  });
}

/**
 * `HOSTED_MODE` is read from the environment when `server/config` is first
 * imported, so each mode needs a fresh module registry.
 */
async function withHostedMode<T>(hosted: boolean, run: () => Promise<T>) {
  const previous = process.env.VITE_MCPJAM_HOSTED_MODE;
  process.env.VITE_MCPJAM_HOSTED_MODE = hosted ? "true" : "false";
  vi.resetModules();
  try {
    if (hosted) {
      // Fabricated test hostnames resolve nowhere, and the guard fails closed
      // on an unresolvable host. Answer for them so these cases exercise the
      // address rules rather than the lookup branch.
      const guard = await import("../../../utils/hosted-egress-guard.js");
      guard.setEgressHostResolverForTests(async () => ["93.184.216.34"]);
    }
    return await run();
  } finally {
    if (previous === undefined) delete process.env.VITE_MCPJAM_HOSTED_MODE;
    else process.env.VITE_MCPJAM_HOSTED_MODE = previous;
    vi.resetModules();
  }
}

describe("hosted doctor — target egress", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    serverUrlRef.current = "https://mcp.example.test/mcp";
    process.env.CONVEX_HTTP_URL = "https://convex.example.com";
    runServerDoctorMock.mockResolvedValue({ status: "ready" });
    global.fetch = vi.fn(async (input) => {
      if (String(input).endsWith("/web/authorize")) {
        return new Response(
          JSON.stringify({
            authorized: true,
            role: "member",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "http",
              url: serverUrlRef.current,
              useOAuth: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl) {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    } else {
      delete process.env.CONVEX_HTTP_URL;
    }
  });

  it("refuses a private target before the doctor runs at all", async () => {
    await withHostedMode(true, async () => {
      for (const url of [
        "http://169.254.169.254/mcp",
        "http://127.0.0.1:3000/mcp",
        "http://10.0.0.5/mcp",
        "http://[::ffff:a9fe:a9fe]/mcp",
      ]) {
        serverUrlRef.current = url;
        const response = await postDoctor();
        expect(response.status).toBe(400);
        const body = (await response.json()) as {
          code: string;
          message: string;
        };
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(body.message).toMatch(/private or internal address/);
      }
      // The connection step is inside `runServerDoctor`; not calling it is what
      // proves nothing dialed the refused address.
      expect(runServerDoctorMock).not.toHaveBeenCalled();
    });
  });

  it("refuses a public hostname that resolves to a private address", async () => {
    await withHostedMode(true, async () => {
      const guard = await import("../../../utils/hosted-egress-guard.js");
      guard.setEgressHostResolverForTests(async () => ["10.1.2.3"]);
      const response = await postDoctor();
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(runServerDoctorMock).not.toHaveBeenCalled();
    });
  });

  it("answers 503 when the target cannot be resolved for a verdict", async () => {
    await withHostedMode(true, async () => {
      const guard = await import("../../../utils/hosted-egress-guard.js");
      guard.setEgressHostResolverForTests(async () => {
        throw new Error("SERVFAIL");
      });
      const response = await postDoctor();
      expect(response.status).toBe(503);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe("SERVER_UNREACHABLE");
      expect(runServerDoctorMock).not.toHaveBeenCalled();
    });
  });

  it("runs against a public target in hosted mode", async () => {
    await withHostedMode(true, async () => {
      const response = await postDoctor();
      expect(response.status).toBe(200);
      expect(runServerDoctorMock).toHaveBeenCalledTimes(1);
    });
  });

  it("leaves localhost alone in local mode", async () => {
    await withHostedMode(false, async () => {
      serverUrlRef.current = "http://localhost:3000/mcp";
      const response = await postDoctor();
      expect(response.status).toBe(200);
      expect(runServerDoctorMock).toHaveBeenCalledTimes(1);
    });
  });
});
