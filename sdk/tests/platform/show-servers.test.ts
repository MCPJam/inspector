import { describe, expect, it, vi } from "vitest";
import {
  buildShowServersPayload,
  PlatformApiError,
  resolveProject,
  SHOW_SERVERS_DOCTOR_CONCURRENCY,
  type PlatformDoctorReport,
  type PlatformProject,
  type PlatformProjectServer,
} from "../../src/platform/index.js";

function project(overrides: Partial<PlatformProject>): PlatformProject {
  return {
    id: "project-id",
    name: "Project",
    description: null,
    icon: null,
    organizationId: "org-a",
    visibility: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function server(overrides: Partial<PlatformProjectServer>): PlatformProjectServer {
  return {
    id: "server-id",
    projectId: "project-id",
    name: "Server",
    enabled: true,
    transportType: "http",
    url: "https://server.example.com/mcp",
    useOAuth: false,
    hasClientSecret: false,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

const PROJECTS: PlatformProject[] = [
  project({ id: "project-old", name: "Old", updatedAt: 100 }),
  project({ id: "project-new", name: "New", updatedAt: 200 }),
];

function doctorReport(
  overrides: Partial<PlatformDoctorReport> = {}
): PlatformDoctorReport {
  const okCheck = { status: "ok" as const, detail: "ok" };
  return {
    target: { kind: "http" },
    generatedAt: "2026-06-11T00:00:00.000Z",
    status: "ready",
    probe: {
      url: "https://server.example.com/mcp",
      protocolVersion: "2025-11-25",
      status: "ready",
      transport: { selected: "streamable-http", attempts: [] },
      initialize: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "server", version: "1.0.0" },
      },
      oauth: { required: false, optional: false, registrationStrategies: [] },
    } as PlatformDoctorReport["probe"],
    connection: { status: "connected", detail: "Connected." },
    initInfo: null,
    capabilities: {},
    tools: [],
    toolsMetadata: {},
    resources: [],
    resourceTemplates: [],
    prompts: [],
    checks: {
      probe: okCheck,
      connection: okCheck,
      initialization: okCheck,
      capabilities: okCheck,
      tools: { status: "ok", detail: "0 tools discovered." },
      resources: { status: "ok", detail: "0 resources discovered." },
      resourceTemplates: okCheck,
      prompts: { status: "ok", detail: "0 prompts discovered." },
    },
    error: null,
    ...overrides,
  };
}

function platformError(
  code: string,
  message: string,
  options: { status?: number; details?: Record<string, unknown>; retryAfter?: number } = {}
): PlatformApiError {
  return new PlatformApiError(message, code, {
    status: options.status ?? 400,
    details: options.details,
    retryAfter: options.retryAfter,
  });
}

describe("resolveProject", () => {
  it("selects the most recently updated project when omitted", () => {
    const result = resolveProject(PROJECTS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.id).toBe("project-new");
    }
  });

  it("selects an exact project ID before considering names", () => {
    const result = resolveProject(
      [...PROJECTS, project({ id: "New", name: "ID Wins", updatedAt: 50 })],
      "New"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.id).toBe("New");
      expect(result.project.name).toBe("ID Wins");
    }
  });

  it("selects a unique project name case-insensitively", () => {
    const result = resolveProject(PROJECTS, "new");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.id).toBe("project-new");
    }
  });

  it("returns an actionable error for duplicate project names", () => {
    const result = resolveProject(
      [
        ...PROJECTS,
        project({ id: "project-new-copy", name: "New", updatedAt: 150 }),
      ],
      "new"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("ambiguous");
      expect(result.message).toContain("project-new");
      expect(result.message).toContain("project-new-copy");
    }
  });

  it("returns available projects for a missing selector", () => {
    const result = resolveProject(PROJECTS, "missing");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Available projects");
      expect(result.message).toContain("project-new");
      expect(result.message).toContain("project-old");
    }
  });
});

describe("buildShowServersPayload", () => {
  it("maps skips, doctor outcomes, and thrown platform errors onto entry statuses", async () => {
    const servers: PlatformProjectServer[] = [
      server({ id: "stdio", name: "Stdio", transportType: "stdio", url: null }),
      server({ id: "no-url", name: "No URL", url: null }),
      server({ id: "insecure", name: "Insecure", url: "http://example.com/mcp" }),
      server({ id: "ready", name: "Ready", url: "https://ready.example.com/mcp" }),
      server({
        id: "broken",
        name: "Broken",
        url: "https://broken.example.com/mcp",
      }),
      server({
        id: "oauth-status",
        name: "OAuth Status",
        url: "https://oauth-status.example.com/mcp",
      }),
      server({
        id: "oauth-envelope",
        name: "OAuth Envelope",
        url: "https://oauth-envelope.example.com/mcp",
      }),
      server({
        id: "oauth-details",
        name: "OAuth Details",
        url: "https://oauth-details.example.com/mcp",
      }),
      server({
        id: "rate-limited",
        name: "Rate Limited",
        url: "https://rate-limited.example.com/mcp",
      }),
      server({
        id: "network",
        name: "Network",
        url: "https://network.example.com/mcp",
      }),
      server({
        id: "forbidden",
        name: "Forbidden",
        url: "https://forbidden.example.com/mcp",
      }),
      server({
        id: "throws",
        name: "Throws",
        url: "https://throws.example.com/mcp",
      }),
    ];

    const doctor = vi.fn(async ({ serverId }: { serverId: string }) => {
      switch (serverId) {
        case "ready":
          return doctorReport({
            probe: {
              ...doctorReport().probe!,
              initialize: {
                protocolVersion: "2025-11-25",
                serverInfo: { name: "ready-server", version: "2.0.0" },
              },
            } as PlatformDoctorReport["probe"],
          });
        case "broken":
          return doctorReport({
            status: "error",
            connection: { status: "error", detail: "Connection refused." },
            error: { code: "CONNECT_FAILED", message: "connect timeout" },
          });
        case "oauth-status":
          return doctorReport({
            status: "oauth_required",
            connection: { status: "skipped", detail: "OAuth required." },
            probe: null,
          });
        case "oauth-envelope":
          throw platformError("OAUTH_REQUIRED", "Server requires OAuth", {
            status: 401,
          });
        case "oauth-details":
          throw platformError("UNAUTHORIZED", "OAuth flow incomplete", {
            status: 401,
            details: { oauthRequired: true },
          });
        case "rate-limited":
          throw platformError("RATE_LIMITED", "Slow down", {
            status: 429,
            retryAfter: 7,
          });
        case "network":
          throw platformError("NETWORK_ERROR", "fetch failed", { status: 0 });
        case "forbidden":
          throw platformError("FORBIDDEN", "Denied", { status: 403 });
        default:
          throw new Error("unexpected failure");
      }
    });

    const payload = await buildShowServersPayload({
      doctor,
      project: PROJECTS[0]!,
      projects: PROJECTS,
      servers,
      generatedAt: "2026-06-11T00:00:00.000Z",
    });

    expect(payload.servers.map((entry) => [entry.id, entry.status])).toEqual([
      ["stdio", "skipped"],
      ["no-url", "skipped"],
      ["insecure", "skipped"],
      ["ready", "reachable"],
      ["broken", "unreachable"],
      ["oauth-status", "reachable"],
      ["oauth-envelope", "reachable"],
      ["oauth-details", "reachable"],
      ["rate-limited", "error"],
      ["network", "unreachable"],
      ["forbidden", "error"],
      ["throws", "unreachable"],
    ]);

    expect(doctor).toHaveBeenCalledTimes(9);
    expect(doctor).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-old", serverId: "ready" })
    );

    const byId = new Map(payload.servers.map((entry) => [entry.id, entry]));
    expect(byId.get("stdio")?.statusDetail).toContain("stdio transport");
    expect(byId.get("insecure")?.statusDetail).toContain("HTTPS");
    expect(byId.get("ready")?.serverInfo).toEqual({
      name: "ready-server",
      version: "2.0.0",
    });
    expect(byId.get("broken")?.statusDetail).toBe("connect timeout");
    expect(byId.get("oauth-status")?.statusDetail).toContain("OAuth required");
    expect(byId.get("oauth-envelope")?.statusDetail).toContain("OAuth required");
    expect(byId.get("oauth-details")?.statusDetail).toContain("OAuth required");
    expect(byId.get("rate-limited")?.statusDetail).toContain("RATE_LIMITED");
    expect(byId.get("rate-limited")?.statusDetail).toContain("Retry after 7s");
    expect(byId.get("forbidden")?.statusDetail).toBe("FORBIDDEN: Denied");
    expect(byId.get("throws")?.statusDetail).toBe("unexpected failure");

    expect(payload.summary).toEqual({
      reachable: 4,
      unreachable: 3,
      skipped: 3,
      error: 2,
    });
    expect(payload.project).toEqual({
      id: "project-old",
      name: "Old",
      organizationId: "org-a",
    });
    expect(payload.otherProjects).toEqual([
      { id: "project-new", name: "New" },
    ]);
  });

  it("adds compact tool, resource, and prompt summaries from the doctor report", async () => {
    const doctor = vi.fn(async () =>
      doctorReport({
        tools: [
          {
            name: "search_tasks",
            title: "Search tasks",
            description: "Search the task index.",
            inputSchema: { type: "object" },
          },
        ],
        resources: [
          {
            uri: "file:///tmp/example.txt",
            name: "example",
            title: "Example",
            description: "Example resource.",
            mimeType: "text/plain",
          },
        ],
        prompts: [
          {
            name: "summarize_project",
            description: "Summarize project state.",
            arguments: [
              { name: "project_id", description: "Project ID.", required: true },
            ],
          },
        ],
        checks: {
          ...doctorReport().checks,
          tools: { status: "ok", detail: "1 tool discovered." },
          resources: { status: "ok", detail: "1 resource discovered." },
          prompts: { status: "error", detail: "prompts/list failed." },
        },
      })
    );

    const payload = await buildShowServersPayload({
      doctor,
      project: PROJECTS[0]!,
      projects: PROJECTS,
      servers: [server({ id: "ready", name: "Ready" })],
      generatedAt: "2026-06-11T00:00:00.000Z",
    });

    expect(payload.servers[0]?.primitives).toEqual({
      tools: {
        status: "loaded",
        statusDetail: "1 tool discovered.",
        items: [
          {
            name: "search_tasks",
            title: "Search tasks",
            description: "Search the task index.",
          },
        ],
      },
      resources: {
        status: "loaded",
        statusDetail: "1 resource discovered.",
        items: [
          {
            uri: "file:///tmp/example.txt",
            name: "example",
            title: "Example",
            description: "Example resource.",
            mimeType: "text/plain",
          },
        ],
      },
      prompts: {
        status: "error",
        statusDetail: "prompts/list failed.",
        items: [
          {
            name: "summarize_project",
            description: "Summarize project state.",
            arguments: [
              { name: "project_id", description: "Project ID.", required: true },
            ],
          },
        ],
      },
    });
  });

  it("truncates long primitive descriptions", async () => {
    const doctor = vi.fn(async () =>
      doctorReport({
        tools: [{ name: "verbose", description: "x".repeat(500) }],
      })
    );

    const payload = await buildShowServersPayload({
      doctor,
      project: PROJECTS[0]!,
      projects: PROJECTS,
      servers: [server({ id: "ready" })],
      generatedAt: "2026-06-11T00:00:00.000Z",
    });

    const description =
      payload.servers[0]?.primitives?.tools.items[0]?.description ?? "";
    expect(description.length).toBe(360);
    expect(description.endsWith("...")).toBe(true);
  });

  it("runs at most SHOW_SERVERS_DOCTOR_CONCURRENCY doctor calls in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const doctor = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return doctorReport();
    });

    await buildShowServersPayload({
      doctor,
      project: PROJECTS[0]!,
      projects: PROJECTS,
      servers: Array.from({ length: 10 }, (_value, index) =>
        server({ id: `server-${index}`, url: `https://s${index}.example.com/mcp` })
      ),
      generatedAt: "2026-06-11T00:00:00.000Z",
    });

    expect(doctor).toHaveBeenCalledTimes(10);
    expect(maxInFlight).toBe(SHOW_SERVERS_DOCTOR_CONCURRENCY);
  });

  it("normalizes a missing organizationId to an empty string", async () => {
    const orphanProject = project({ id: "p", organizationId: null });
    const payload = await buildShowServersPayload({
      doctor: async () => doctorReport(),
      project: orphanProject,
      projects: [orphanProject],
      servers: [],
      generatedAt: "2026-06-11T00:00:00.000Z",
    });

    expect(payload.project.organizationId).toBe("");
    expect(payload.servers).toEqual([]);
    expect(payload.summary).toEqual({
      reachable: 0,
      unreachable: 0,
      skipped: 0,
      error: 0,
    });
  });
});
