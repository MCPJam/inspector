import { describe, expect, it, vi } from "vitest";
import { PlatformApiClient } from "../../src/platform/client.js";
import { diagnoseServerOperation } from "../../src/platform/operations.js";

const PROJECT = {
  id: "project-1",
  name: "Dogfood",
  description: null,
  icon: null,
  organizationId: "org-1",
  visibility: null,
  createdAt: 1,
  updatedAt: 1,
};

function server(
  id: string,
  name: string,
  transportType: string,
  url: string | null
) {
  return {
    id,
    projectId: PROJECT.id,
    name,
    enabled: true,
    transportType,
    url,
    useOAuth: false,
    hasClientSecret: false,
    createdAt: null,
    updatedAt: null,
  };
}

const SERVERS = [
  server("srv-local", "local-proxy", "http", "http://127.0.0.1:8788/mcp"),
  server("srv-https", "docs", "http", "https://docs.example.com/mcp"),
  server("srv-nourl", "half-saved", "http", null),
];

/** A platform whose doctor route answers each server the way `doctor` says. */
function makeClient(doctor: (serverId: string) => Response) {
  const fetchMock = vi.fn(async (target: unknown) => {
    const path = new URL(String(target)).pathname;
    if (path === "/api/v1/projects") return Response.json({ items: [PROJECT] });
    if (path === `/api/v1/projects/${PROJECT.id}/servers`) {
      return Response.json({ items: SERVERS });
    }
    const match = path.match(/\/servers\/([^/]+)\/doctor$/);
    if (match) return doctor(match[1]!);
    return Response.json({ code: "NOT_FOUND", message: path }, { status: 404 });
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  const doctorCalls = () =>
    fetchMock.mock.calls.filter(([target]) =>
      String(target).endsWith("/doctor")
    ).length;
  return { client, doctorCalls };
}

const httpsRefusal = (serverId: string) =>
  Response.json(
    {
      code: "FEATURE_NOT_SUPPORTED",
      message: "Hosted mode requires HTTPS server URLs",
      details: { serverId, refusalReason: "hosted_requires_https" },
    },
    { status: 422 }
  );

describe("diagnose_server on a server hosted MCPJam will not dial", () => {
  it("reports the platform's https refusal as the diagnosis", async () => {
    const { client, doctorCalls } = makeClient(httpsRefusal);

    const result = await diagnoseServerOperation.execute(
      { project: "Dogfood", server: "local-proxy" },
      { client }
    );

    expect(doctorCalls()).toBe(1);
    expect(result.project).toEqual({
      id: "project-1",
      name: "Dogfood",
      organizationId: "org-1",
    });
    expect(result.server).toEqual({ id: "srv-local", name: "local-proxy" });
    expect(result.report).toMatchObject({
      status: "error",
      target: {
        scope: "hosted",
        projectId: "project-1",
        serverId: "srv-local",
        url: "http://127.0.0.1:8788/mcp",
      },
      connection: { status: "error" },
      error: {
        code: "FEATURE_NOT_SUPPORTED",
        message: "Hosted mode requires HTTPS server URLs",
        details: { refusalReason: "hosted_requires_https" },
      },
    });
    expect(result.report.connection.detail).toMatch(/https:\/\//);
    expect(result.report.connection.detail).toMatch(/mcpjam cloud tunnel/);
    expect(result.report.checks.connection.status).toBe("error");
    expect(result.report.checks.tools.status).toBe("skipped");
  });

  it("reports a server with no URL without calling the doctor", async () => {
    const { client, doctorCalls } = makeClient(httpsRefusal);

    const result = await diagnoseServerOperation.execute(
      { project: "Dogfood", server: "half-saved" },
      { client }
    );

    expect(doctorCalls()).toBe(0);
    expect(result.report.error?.details).toEqual({
      refusalReason: "hosted_no_url",
    });
    expect(result.report.connection.detail).toMatch(/no URL saved/);
  });

  it("returns a reachable server's report unchanged", async () => {
    const { client } = makeClient(() =>
      Response.json({ status: "ready", checks: {} })
    );

    const result = await diagnoseServerOperation.execute(
      { project: "Dogfood", server: "docs" },
      { client }
    );

    expect(result.report).toEqual({ status: "ready", checks: {} });
  });

  it("still raises a feature refusal that is not about reaching the server", async () => {
    const { client } = makeClient(() =>
      Response.json(
        { code: "FEATURE_NOT_SUPPORTED", message: "Not on this deployment" },
        { status: 422 }
      )
    );

    await expect(
      diagnoseServerOperation.execute(
        { project: "Dogfood", server: "docs" },
        { client }
      )
    ).rejects.toMatchObject({ code: "FEATURE_NOT_SUPPORTED" });
  });

  it("still raises an outage and an unknown server", async () => {
    const { client } = makeClient(() =>
      Response.json(
        { code: "INTERNAL_ERROR", message: "boom" },
        { status: 500 }
      )
    );

    await expect(
      diagnoseServerOperation.execute(
        { project: "Dogfood", server: "docs" },
        { client }
      )
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(
      diagnoseServerOperation.execute(
        { project: "Dogfood", server: "nope" },
        { client }
      )
    ).rejects.toThrow(/nope/);
  });
});
