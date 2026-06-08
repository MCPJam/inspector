/**
 * First batch of public-API-backed MCP tools: read-only product state (Convex)
 * + safe diagnostics (Inspector Node). Mutating tools (execute_tool,
 * run_eval_suite, connect_server) ship in a follow-up behind the
 * X-MCPJam-Approval flow.
 */
import { z } from "zod";
import type { SessionToolRegistrar } from "./sessionToolRegistrar.js";
import type { McpJamMcpServer } from "../server.js";
import { registerPublicApiTool } from "../lib/registerPublicApiTool.js";
import {
  toQuery,
  type ChatSessionDto,
  type EvalSuiteDto,
  type MeDto,
  type ProjectDto,
  type ServerDto,
  type V1Page,
} from "../lib/public-api-client.js";

const READ_ONLY = { readOnlyHint: true } as const;

// Permissive output schemas: list tools always return { items, nextCursor? };
// resource tools return a single (shape-varying) object.
const pageOutputSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().optional(),
});
const resourceOutputSchema = z.object({}).passthrough();

function enc(value: string): string {
  return encodeURIComponent(value);
}

export function registerPublicApiTools(
  registrar: SessionToolRegistrar,
  agent: McpJamMcpServer
): void {
  // ───────────────────────── Convex-backed reads ─────────────────────────

  registerPublicApiTool(registrar, agent, {
    name: "get_me",
    title: "Get current MCPJam user",
    description: "Return the authenticated MCPJam user's profile.",
    inputSchema: z.object({}),
    outputSchema: z.object({ id: z.string() }).passthrough(),
    annotations: READ_ONLY,
    run: (_args, client) => client.get<MeDto>("convex", "/me"),
  });

  registerPublicApiTool(registrar, agent, {
    name: "list_projects",
    title: "List MCPJam projects",
    description:
      "List the authenticated user's MCPJam projects. Optionally filter by organizationId.",
    inputSchema: z.object({
      organizationId: z.string().min(1).optional(),
    }),
    outputSchema: pageOutputSchema,
    annotations: READ_ONLY,
    run: (args, client) =>
      client.get<V1Page<ProjectDto>>(
        "convex",
        `/projects${toQuery({ organizationId: args.organizationId })}`
      ),
  });

  registerPublicApiTool(registrar, agent, {
    name: "list_project_servers",
    title: "List MCPJam servers in a project",
    description: "List the MCP servers configured in a project.",
    inputSchema: z.object({ projectId: z.string().min(1) }),
    outputSchema: pageOutputSchema,
    annotations: READ_ONLY,
    run: (args, client) =>
      client.get<V1Page<ServerDto>>(
        "convex",
        `/project-servers${toQuery({ projectId: args.projectId })}`
      ),
  });

  registerPublicApiTool(registrar, agent, {
    name: "list_chat_sessions",
    title: "List MCPJam chat sessions",
    description:
      "List direct chat sessions, optionally scoped to a project. Cursor-paginated: pass the returned nextCursor as `before`.",
    inputSchema: z.object({
      projectId: z.string().min(1).optional(),
      status: z.enum(["active", "archived"]).optional(),
      limit: z.number().int().positive().max(200).optional(),
      before: z.number().int().optional(),
    }),
    outputSchema: pageOutputSchema,
    annotations: READ_ONLY,
    run: (args, client) =>
      client.get<V1Page<ChatSessionDto>>(
        "convex",
        `/chat-sessions${toQuery({
          projectId: args.projectId,
          status: args.status,
          limit: args.limit,
          before: args.before,
        })}`
      ),
  });

  registerPublicApiTool(registrar, agent, {
    name: "list_eval_suites",
    title: "List MCPJam eval suites",
    description:
      "List eval (test) suites with their latest-run summary. Optionally scope by projectId or organizationId.",
    inputSchema: z.object({
      projectId: z.string().min(1).optional(),
      organizationId: z.string().min(1).optional(),
    }),
    outputSchema: pageOutputSchema,
    annotations: READ_ONLY,
    run: (args, client) =>
      client.get<V1Page<EvalSuiteDto>>(
        "convex",
        `/eval-suites${toQuery({
          projectId: args.projectId,
          organizationId: args.organizationId,
        })}`
      ),
  });

  // ──────────────────── Inspector-Node-backed live MCP ───────────────────

  const serverScope = z.object({
    projectId: z.string().min(1),
    serverId: z.string().min(1),
  });

  registerPublicApiTool(registrar, agent, {
    name: "list_server_tools",
    title: "List a server's MCP tools",
    description: "Connect to a hosted MCP server and list its tools.",
    inputSchema: serverScope,
    outputSchema: pageOutputSchema,
    annotations: READ_ONLY,
    run: (args, client) =>
      client.post<V1Page<unknown>>(
        "inspector",
        `/projects/${enc(args.projectId)}/servers/${enc(args.serverId)}/tools`
      ),
  });

  registerPublicApiTool(registrar, agent, {
    name: "list_server_prompts",
    title: "List a server's MCP prompts",
    description: "Connect to a hosted MCP server and list its prompts.",
    inputSchema: serverScope,
    outputSchema: pageOutputSchema,
    annotations: READ_ONLY,
    run: (args, client) =>
      client.post<V1Page<unknown>>(
        "inspector",
        `/projects/${enc(args.projectId)}/servers/${enc(args.serverId)}/prompts`
      ),
  });

  registerPublicApiTool(registrar, agent, {
    name: "read_server_resource",
    title: "Read a server resource",
    description:
      "Read a single resource (by uri) from a hosted MCP server.",
    inputSchema: serverScope.extend({ uri: z.string().min(1) }),
    outputSchema: resourceOutputSchema,
    annotations: READ_ONLY,
    run: (args, client) =>
      client.post(
        "inspector",
        `/projects/${enc(args.projectId)}/servers/${enc(
          args.serverId
        )}/resources/read`,
        { uri: args.uri }
      ),
  });

  registerPublicApiTool(registrar, agent, {
    name: "server_doctor",
    title: "Diagnose a hosted MCP server",
    description:
      "Run health diagnostics (probe, connect, initialize, capabilities) against a hosted MCP server.",
    inputSchema: serverScope,
    outputSchema: resourceOutputSchema,
    annotations: READ_ONLY,
    run: (args, client) =>
      client.post(
        "inspector",
        `/projects/${enc(args.projectId)}/servers/${enc(args.serverId)}/doctor`
      ),
  });

  registerPublicApiTool(registrar, agent, {
    name: "validate_server",
    title: "Validate a hosted MCP server",
    description:
      "Connect to a hosted MCP server and capture an inspection snapshot.",
    inputSchema: serverScope,
    outputSchema: resourceOutputSchema,
    annotations: READ_ONLY,
    run: (args, client) =>
      client.post(
        "inspector",
        `/projects/${enc(args.projectId)}/servers/${enc(
          args.serverId
        )}/validate`
      ),
  });
}
