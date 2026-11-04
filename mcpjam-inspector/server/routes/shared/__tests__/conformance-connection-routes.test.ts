import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { check, authorize } = vi.hoisted(() => ({
  check: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock("../conformance-connection.js", () => ({
  checkConformanceConnection: check,
}));
vi.mock("../../../config.js", async (original) => ({
  ...(await original<typeof import("../../../config.js")>()),
  HOSTED_MODE: true,
}));
vi.mock("../../web/auth.js", async () => {
  const { z } = await import("zod");
  return {
    projectServerSchema: z
      .object({ projectId: z.string(), serverId: z.string() })
      .passthrough(),
    authorizeServer: authorize,
    toHttpConfig: vi.fn(),
    handleRoute: async (
      c: { json: (value: unknown, status: number) => Response },
      handler: () => Promise<unknown>,
    ) => {
      try {
        return c.json(await handler(), 200);
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : "Failed" },
          error instanceof Error &&
            "status" in error &&
            typeof error.status === "number"
            ? error.status
            : 500,
        );
      }
    },
  };
});

beforeEach(async () => {
  vi.clearAllMocks();
  check.mockResolvedValue({ status: "ready" });
  authorize.mockResolvedValue({
    serverConfig: {
      transportType: "http",
      url: "https://bart.test/mcp",
      headers: { "X-Custom": "saved" },
    },
    oauthAccessToken: "saved-token",
  });
  const guard = await import("../../../utils/hosted-egress-guard.js");
  guard.setEgressHostResolverForTests(async () => ["93.184.216.34"]);
});
afterEach(async () => {
  const guard = await import("../../../utils/hosted-egress-guard.js");
  guard.setEgressHostResolverForTests(null);
});

async function post(mode: "local" | "hosted", fields: Record<string, unknown>) {
  const app = new Hono();
  if (mode === "local") {
    const { default: routes } = await import("../../mcp/conformance.js");
    app.use("*", async (c, next) => {
      Object.assign(c, {
        mcpClientManager: {
          getServerConfig: () => ({
            url: new URL("https://bart.test/mcp"),
            accessToken: "saved-token",
            requestInit: { headers: { "X-Custom": "saved" } },
          }),
        },
      });
      await next();
    });
    app.route("/conformance", routes);
  } else {
    const { default: routes } = await import("../../web/conformance.js");
    app.route("/conformance", routes);
  }
  return app.request("/conformance/connection-check", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-login",
    },
    body: JSON.stringify({ projectId: "p1", serverId: "bart", ...fields }),
  });
}

describe.each(["local", "hosted"] as const)(
  "%s connection check route",
  (mode) => {
    it("uses the authorized target and saved login, ignoring body credentials", async () => {
      const response = await post(mode, {
        protocolVersion: "2026-07-28",
        serverUrl: "https://attacker.test/mcp",
        accessToken: "body-token",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ready" });
      const [config, version] = check.mock.calls[0];
      expect(String(config.url)).toBe("https://bart.test/mcp");
      expect(version).toBe("2026-07-28");
      expect(
        mode === "hosted"
          ? config.requestInit.headers.Authorization
          : config.accessToken,
      ).toBe(mode === "hosted" ? "Bearer saved-token" : "saved-token");
      expect(JSON.stringify(config)).not.toContain("body-token");
    });

    it.each([
      {},
      { protocolVersion: "auto" },
      { protocolVersion: "not-a-version" },
    ])("rejects invalid pins: %s", async (body) => {
      expect((await post(mode, body)).status).toBe(400);
      expect(check).not.toHaveBeenCalled();
    });

    it("returns a typed version refusal without launching a suite", async () => {
      const refused = {
        status: "unsupported",
        protocolVersion: "2026-07-28",
        supportedVersions: ["2025-06-18"],
      };
      check.mockResolvedValue(refused);
      expect(
        await (await post(mode, { protocolVersion: "2026-07-28" })).json(),
      ).toEqual(refused);
    });
  },
);

describe("hosted connection check protections", () => {
  it("requires access to the saved server before probing", async () => {
    authorize.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 }),
    );
    expect(
      (await post("hosted", { protocolVersion: "2026-07-28" })).status,
    ).toBe(403);
    expect(check).not.toHaveBeenCalled();
  });

  it("refuses a private target before opening a connection", async () => {
    authorize.mockResolvedValue({
      serverConfig: { transportType: "http", url: "http://127.0.0.1/mcp" },
    });
    expect(
      (await post("hosted", { protocolVersion: "2026-07-28" })).status,
    ).toBe(400);
    expect(check).not.toHaveBeenCalled();
  });
});
