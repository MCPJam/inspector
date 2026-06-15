import { afterEach, describe, expect, it, vi } from "vitest";
import { listProjectsOperation } from "@mcpjam/sdk/platform";
import {
  PLATFORM_CATALOG_OPERATIONS,
  PLATFORM_TOOL_WIDGET_VIEWS,
  registerPlatformCatalogTools,
  runPlatformOperation,
} from "../src/tools/platformTools.js";
import {
  registerShowServersTool,
  SHOW_SERVERS_RESOURCE_URI,
} from "../src/tools/showServers.js";
import { PLATFORM_WIDGET_RESOURCE_URIS } from "../src/shared/platform-widgets.js";
import type { McpJamMcpServer } from "../src/server.js";
import type { SessionToolRegistrar } from "../src/tools/sessionToolRegistrar.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
};

type CapturedRegistration = {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
    };
  };
  callback: (input: unknown) => Promise<unknown>;
  ui?: {
    resourceUri: string;
    html: string;
    callback?: (input: unknown) => Promise<unknown>;
  };
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
    // runPlatformOperation resolves the bearer via getBearerToken() (async, so
    // anonymous sessions can mint lazily). The stub just returns the override.
    getBearerToken: async () => overrides.bearerToken,
    runtimeEnv: {
      PLATFORM_API_URL:
        overrides.platformApiUrl ?? "https://staging.example.com/api/v1",
    },
  } as unknown as McpJamMcpServer;
}

const WIDGET_TOOLS: Record<string, keyof typeof PLATFORM_WIDGET_RESOURCE_URIS> =
  {
    list_eval_suites: "eval_suites",
    list_eval_suite_runs: "eval_suite_runs",
    get_eval_run: "eval_run",
    list_eval_run_iterations: "eval_run_iterations",
    list_chatboxes: "chatboxes",
    get_chatbox: "chatbox",
  };

const PLAIN_TOOLS = [
  "list_projects",
  "list_project_servers",
  // Server live operations are agent-oriented payloads with no widget view.
  "diagnose_server",
  "list_server_tools",
  "call_server_tool",
  "list_server_prompts",
  "get_server_prompt",
  "list_server_resources",
  "read_server_resource",
  "run_eval_suite",
  "get_eval_iteration_trace",
  "list_chat_sessions",
];

function stubPlatformFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: unknown) => {
      const path = new URL(String(target)).pathname;
      for (const [suffix, payload] of Object.entries(routes)) {
        if (path.endsWith(suffix)) {
          return Response.json(payload);
        }
      }
      throw new Error(`Unexpected fetch: ${path}`);
    })
  );
}

const PROJECTS_PAGE = {
  items: [
    {
      id: "project-1",
      name: "Project One",
      organizationId: "org-1",
      updatedAt: 1,
    },
  ],
};

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
    expect(registration.config.annotations?.readOnlyHint).toBe(true);
    expect(registration.ui?.resourceUri).toBe(SHOW_SERVERS_RESOURCE_URI);
    expect(registration.ui?.html).toContain("<html");
  });

  it("registers the whole operation catalog in order", () => {
    const { registrar, registrations } = fakeRegistrar();

    registerPlatformCatalogTools(registrar, fakeAgent({ bearerToken: "jwt" }));

    expect(registrations.map((registration) => registration.name)).toEqual([
      "list_projects",
      "list_project_servers",
      "diagnose_server",
      "list_server_tools",
      "call_server_tool",
      "list_server_prompts",
      "get_server_prompt",
      "list_server_resources",
      "read_server_resource",
      "list_eval_suites",
      "list_eval_suite_runs",
      "run_eval_suite",
      "get_eval_run",
      "list_eval_run_iterations",
      "get_eval_iteration_trace",
      "list_chatboxes",
      "get_chatbox",
      "list_chat_sessions",
    ]);
    expect(registrations).toHaveLength(PLATFORM_CATALOG_OPERATIONS.length);
    for (const registration of registrations) {
      expect(registration.config.description).toBeTruthy();
    }
  });

  it("attaches the shared widget bundle to the widget-backed tools only", () => {
    const { registrar, registrations } = fakeRegistrar();

    registerPlatformCatalogTools(registrar, fakeAgent({ bearerToken: "jwt" }));

    for (const registration of registrations) {
      const view = WIDGET_TOOLS[registration.name];
      if (view) {
        expect(registration.ui?.resourceUri).toBe(
          PLATFORM_WIDGET_RESOURCE_URIS[view]
        );
        expect(registration.ui?.html).toContain("<html");
        expect(registration.ui?.callback).toBeTypeOf("function");
      } else {
        expect(PLAIN_TOOLS).toContain(registration.name);
        expect(registration.ui).toBeUndefined();
      }
    }
    expect(Object.keys(PLATFORM_TOOL_WIDGET_VIEWS).sort()).toEqual(
      Object.keys(WIDGET_TOOLS).sort()
    );
  });

  it("marks reads read-only, the eval-run starter as non-destructive write, and call_server_tool as assume-destructive", () => {
    const { registrar, registrations } = fakeRegistrar();

    registerPlatformCatalogTools(registrar, fakeAgent({ bearerToken: "jwt" }));

    for (const registration of registrations) {
      if (registration.name === "run_eval_suite") {
        expect(registration.config.annotations).toEqual({
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        });
      } else if (registration.name === "call_server_tool") {
        // Arbitrary third-party tool execution: destructive/idempotent hints
        // are deliberately absent so clients assume destructive (spec
        // default).
        expect(registration.config.annotations).toEqual({
          readOnlyHint: false,
        });
      } else {
        expect(registration.config.annotations).toEqual({
          readOnlyHint: true,
        });
      }
    }
  });
});

describe("widget payload tagging", () => {
  it("tags the widget callback's payload in both channels and leaves the plain callback untagged", async () => {
    stubPlatformFetch({
      "/projects": PROJECTS_PAGE,
      "/chatboxes": {
        items: [
          {
            id: "chatbox-1",
            name: "Support bot",
            serverCount: 0,
            serverNames: [],
          },
        ],
      },
    });
    const { registrar, registrations } = fakeRegistrar();
    registerPlatformCatalogTools(registrar, fakeAgent({ bearerToken: "jwt" }));
    const registration = registrations.find(
      (candidate) => candidate.name === "list_chatboxes"
    )!;

    const tagged = (await registration.ui!.callback!({})) as ToolResult;
    expect(tagged.isError).toBeUndefined();
    expect(tagged.structuredContent?.widget).toBe("chatboxes");
    expect(JSON.parse(tagged.content[0]!.text).widget).toBe("chatboxes");

    const plain = (await registration.callback({})) as ToolResult;
    expect(plain.isError).toBeUndefined();
    expect(plain.structuredContent).not.toHaveProperty("widget");
    expect(JSON.parse(plain.content[0]!.text)).not.toHaveProperty("widget");
  });

  it("tags show_servers widget payloads with the servers view", async () => {
    stubPlatformFetch({
      "/projects": PROJECTS_PAGE,
      "/servers": { items: [] },
    });
    const { registrar, registrations } = fakeRegistrar();
    registerShowServersTool(registrar, fakeAgent({ bearerToken: "jwt" }));

    const result = (await registrations[0]!.ui!.callback!({})) as ToolResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.widget).toBe("servers");
    expect(result.structuredContent?.servers).toEqual([]);
  });
});

describe("runPlatformOperation", () => {
  it("returns a tool error when the request has no bearer token", async () => {
    const result = (await runPlatformOperation(
      fakeAgent(),
      listProjectsOperation,
      {}
    )) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("bearer token");
  });

  it("caps the model-visible text while keeping structuredContent complete", async () => {
    const hugeDescription = "x".repeat(60_000);
    const hugePage = {
      items: [
        {
          id: "project-1",
          name: "Big Project",
          description: hugeDescription,
          icon: null,
          organizationId: null,
          visibility: "private",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(hugePage))
    );

    const result = (await runPlatformOperation(
      fakeAgent({ bearerToken: "user-jwt" }),
      listProjectsOperation,
      {}
    )) as ToolResult;

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text.length).toBeLessThan(25_000);
    expect(text).toContain("…[truncated");
    // The complete payload survives for widgets/programmatic consumers.
    expect(
      (result.structuredContent as { items: Array<{ description: string }> })
        .items[0]!.description
    ).toBe(hugeDescription);
  });

  it("calls the configured platform API with the agent bearer and returns structured content", async () => {
    const fetchMock = vi.fn(async () => Response.json(PROJECTS_PAGE));
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
    expect(String(target)).toBe("https://staging.example.com/api/v1/projects");
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
        Response.json({ code: "FORBIDDEN", message: "Denied" }, { status: 403 })
      )
    );

    const result = (await runPlatformOperation(
      fakeAgent({ bearerToken: "user-jwt" }),
      listProjectsOperation,
      {}
    )) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("FORBIDDEN: Denied");
  });

  it("carries the error code in structuredContent so the widget can branch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "NOT_FOUND", message: "No accessible MCPJam projects were found." },
          { status: 404 }
        )
      )
    );

    const result = (await runPlatformOperation(
      fakeAgent({ bearerToken: "user-jwt" }),
      listProjectsOperation,
      {}
    )) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toEqual({
      code: "NOT_FOUND",
      message: "No accessible MCPJam projects were found.",
    });
  });
});
