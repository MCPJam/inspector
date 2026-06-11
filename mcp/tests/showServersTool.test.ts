import { afterEach, describe, expect, it, vi } from "vitest";
import { listProjectsOperation } from "@mcpjam/sdk/platform";
import {
  registerListProjectsTool,
  registerListProjectServersTool,
  registerShowServersTool,
  runPlatformOperation,
  SHOW_SERVERS_RESOURCE_URI,
} from "../src/tools/showServers.js";
import type { McpJamMcpServer } from "../src/server.js";
import type { SessionToolRegistrar } from "../src/tools/sessionToolRegistrar.js";

type CapturedRegistration = {
  name: string;
  config: { title?: string; description?: string; inputSchema?: unknown };
  callback: (input: unknown) => Promise<unknown>;
  ui?: { resourceUri: string; html: string };
};

function fakeRegistrar(): {
  registrar: SessionToolRegistrar;
  registrations: CapturedRegistration[];
} {
  const registrations: CapturedRegistration[] = [];
  const registrar = {
    registerTool(
      name: string,
      config: CapturedRegistration["config"],
      callback: CapturedRegistration["callback"],
      ui?: CapturedRegistration["ui"]
    ) {
      registrations.push({ name, config, callback, ui });
      return {} as never;
    },
    setUiEnabled() {},
  } as unknown as SessionToolRegistrar;
  return { registrar, registrations };
}

function fakeAgent(
  overrides: { bearerToken?: string; platformApiUrl?: string } = {}
): McpJamMcpServer {
  return {
    bearerToken: overrides.bearerToken,
    runtimeEnv: {
      PLATFORM_API_URL:
        overrides.platformApiUrl ?? "https://staging.example.com/api/v1",
    },
  } as unknown as McpJamMcpServer;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("platform tool registration", () => {
  it("registers show_servers with the MCP Apps UI resource", () => {
    const { registrar, registrations } = fakeRegistrar();

    registerShowServersTool(registrar, fakeAgent({ bearerToken: "jwt" }));

    expect(registrations).toHaveLength(1);
    const registration = registrations[0]!;
    expect(registration.name).toBe("show_servers");
    expect(registration.ui?.resourceUri).toBe(SHOW_SERVERS_RESOURCE_URI);
    expect(registration.ui?.html).toContain("<html");
  });

  it("registers the listing tools as plain tools without UI", () => {
    const { registrar, registrations } = fakeRegistrar();
    const agent = fakeAgent({ bearerToken: "jwt" });

    registerListProjectsTool(registrar, agent);
    registerListProjectServersTool(registrar, agent);

    expect(registrations.map((registration) => registration.name)).toEqual([
      "list_projects",
      "list_project_servers",
    ]);
    for (const registration of registrations) {
      expect(registration.ui).toBeUndefined();
      expect(registration.config.description).toBeTruthy();
    }
  });
});

describe("runPlatformOperation", () => {
  it("returns a tool error when the request has no bearer token", async () => {
    const result = (await runPlatformOperation(
      fakeAgent(),
      listProjectsOperation,
      {}
    )) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("bearer token");
  });

  it("calls the configured platform API with the agent bearer and returns structured content", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: "project-1",
            name: "Project One",
            organizationId: "org-1",
            updatedAt: 1,
          },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = (await runPlatformOperation(
      fakeAgent({ bearerToken: "user-jwt" }),
      listProjectsOperation,
      {}
    )) as {
      isError?: boolean;
      structuredContent: { items: Array<{ id: string }> };
    };

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.items[0]?.id).toBe("project-1");

    const [target, init] = fetchMock.mock.calls[0]!;
    expect(String(target)).toBe(
      "https://staging.example.com/api/v1/projects"
    );
    expect(
      new Headers((init as RequestInit).headers as HeadersInit).get(
        "authorization"
      )
    ).toBe("Bearer user-jwt");
  });

  it("maps wire errors onto tool errors with their stable code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "FORBIDDEN", message: "Denied" },
          { status: 403 }
        )
      )
    );

    const result = (await runPlatformOperation(
      fakeAgent({ bearerToken: "user-jwt" }),
      listProjectsOperation,
      {}
    )) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("FORBIDDEN: Denied");
  });
});
