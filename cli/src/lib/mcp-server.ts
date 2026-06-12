import {
  MCPClientManager,
  probeMcpServer,
  runServerDoctor,
  type MCPServerConfig,
} from "@mcpjam/sdk";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { normalizeCliError, usageError } from "./output.js";
import { redactSensitiveValue } from "./redaction.js";
import { summarizeServerDoctorTarget } from "./server-doctor.js";
import { listToolsWithMetadata } from "./server-ops.js";

export interface McpJamMcpServerOptions {
  version: string;
  defaultTimeoutMs?: number;
}

export interface McpJamMcpServerHandle {
  server: McpServer;
  manager: MCPClientManager;
  close(): Promise<void>;
}

interface BufferedNotification {
  server: string;
  method: string;
  params: unknown;
  receivedAt: string;
}

const NOTIFICATION_BUFFER_LIMIT = 1_000;

/**
 * Server-emitted notification methods buffered per connection so agents can
 * assert on list_changed/log/progress behavior that one-shot CLI runs miss.
 */
const WATCHED_NOTIFICATION_METHODS = [
  "notifications/message",
  "notifications/progress",
  "notifications/tools/list_changed",
  "notifications/resources/list_changed",
  "notifications/resources/updated",
  "notifications/prompts/list_changed",
] as const;

const SERVER_INSTRUCTIONS = `MCPJam is a debugger and test harness for other MCP servers.

Typical flow: connect_server (stdio command or HTTP url) -> list_tools / call_tool / list_resources / read_resource / list_prompts / get_prompt -> get_notifications to see what the target emitted -> disconnect_server. Connections stay open between calls, so notifications, list_changed events, and session state are observable across calls.

For one-shot triage without managing a connection, use server_doctor (full diagnostic sweep, stdio or HTTP) or probe_server (HTTP-only reachability/auth probe). Tool results are JSON payloads about the target server; call_tool returns the target's raw CallToolResult, so check its "isError" field to detect tool-level failures.`;

const targetConfigFields = {
  url: z
    .string()
    .optional()
    .describe(
      "HTTP(S) MCP server URL. Provide either url (HTTP transport) or command (stdio transport), not both.",
    ),
  accessToken: z
    .string()
    .optional()
    .describe("Bearer access token for HTTP servers (HTTP only)"),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Extra HTTP headers (HTTP only)"),
  command: z
    .string()
    .optional()
    .describe("Executable that starts a stdio MCP server, e.g. \"node\""),
  args: z
    .array(z.string())
    .optional()
    .describe("Arguments for the stdio command (stdio only)"),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Environment variables for the stdio process; merged over the inherited environment (stdio only)",
    ),
  cwd: z
    .string()
    .optional()
    .describe("Working directory for the stdio process (stdio only)"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Per-request timeout in milliseconds"),
};

type TargetConfigInput = {
  url?: string;
  accessToken?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
};

export function buildTargetConfig(
  input: TargetConfigInput,
  defaultTimeoutMs: number,
): { config: MCPServerConfig; target: string } {
  const url = input.url?.trim();
  const command = input.command?.trim();

  if (Boolean(url) === Boolean(command)) {
    throw usageError(
      "Specify exactly one target: either \"url\" (HTTP) or \"command\" (stdio).",
    );
  }

  const timeout = input.timeoutMs ?? defaultTimeoutMs;

  if (url) {
    if (input.args || input.env || input.cwd) {
      throw usageError(
        "\"args\", \"env\", and \"cwd\" can only be used together with \"command\".",
      );
    }

    try {
      new URL(url);
    } catch {
      throw usageError(`Invalid URL: ${url}`);
    }

    return {
      target: url,
      config: {
        url,
        ...(input.accessToken ? { accessToken: input.accessToken } : {}),
        ...(input.headers ? { requestInit: { headers: input.headers } } : {}),
        timeout,
      },
    };
  }

  if (input.accessToken || input.headers) {
    throw usageError(
      "\"accessToken\" and \"headers\" can only be used together with \"url\".",
    );
  }

  return {
    target: command!,
    config: {
      command: command!,
      ...(input.args ? { args: input.args } : {}),
      ...(input.env ? { env: input.env } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      stderr: "pipe",
      timeout,
    },
  };
}

export function deriveServerName(
  input: Pick<TargetConfigInput, "url" | "command">,
  taken: (name: string) => boolean,
): string {
  let base = "server";
  const url = input.url?.trim();
  const command = input.command?.trim();

  if (url) {
    try {
      base = new URL(url).hostname || base;
    } catch {
      // Fall back to the generic base; buildTargetConfig reports invalid URLs.
    }
  } else if (command) {
    const segments = command.split(/[\\/]/).filter(Boolean);
    base = segments[segments.length - 1] ?? base;
  }

  if (!taken(base)) {
    return base;
  }

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken(candidate)) {
      return candidate;
    }
  }
}

function toToolResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function toToolError(error: unknown) {
  const normalized = normalizeCliError(error);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: {
              code: normalized.code,
              message: normalized.message,
              ...(normalized.details === undefined
                ? {}
                : { details: normalized.details }),
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function runTool(operation: () => Promise<unknown>) {
  try {
    return toToolResult(await operation());
  } catch (error) {
    return toToolError(error);
  }
}

export function createMcpJamMcpServer(
  options: McpJamMcpServerOptions,
): McpJamMcpServerHandle {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const manager = new MCPClientManager(
    {},
    {
      defaultClientName: "mcpjam",
      defaultClientVersion: options.version,
      defaultTimeout: defaultTimeoutMs,
    },
  );

  const notifications: BufferedNotification[] = [];
  let droppedNotifications = 0;

  const bufferNotification = (server: string, notification: unknown) => {
    const { method, params } = (notification ?? {}) as {
      method?: string;
      params?: unknown;
    };
    notifications.push({
      server,
      method: method ?? "unknown",
      params: params ?? null,
      receivedAt: new Date().toISOString(),
    });
    if (notifications.length > NOTIFICATION_BUFFER_LIMIT) {
      notifications.splice(0, notifications.length - NOTIFICATION_BUFFER_LIMIT);
      droppedNotifications += 1;
    }
  };

  const watchNotifications = (server: string) => {
    for (const method of WATCHED_NOTIFICATION_METHODS) {
      manager.addNotificationHandler(server, method, (notification) =>
        bufferNotification(server, notification),
      );
    }
  };

  const requireConnected = (server: string) => {
    const status = manager.getConnectionStatus(server);
    if (status !== "connected") {
      throw usageError(
        `Server "${server}" is not connected (status: ${status}). Call connect_server first; list_servers shows open connections.`,
      );
    }
  };

  const describeServer = (server: string) => {
    const config = manager.getServerConfig(server);
    const targetLabel = config
      ? "url" in config && config.url
        ? config.url
        : [config.command, ...(config.args ?? [])].join(" ")
      : "unknown";
    return {
      server,
      status: manager.getConnectionStatus(server),
      target: config
        ? summarizeServerDoctorTarget(targetLabel, config)
        : null,
    };
  };

  const server = new McpServer(
    {
      name: "mcpjam",
      title: "MCPJam MCP Server",
      version: options.version,
    },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "connect_server",
    {
      title: "Connect to an MCP server",
      description:
        "Open a persistent connection to an MCP server under test, over HTTP (url) or stdio (command). The connection stays open across tool calls so session state and notifications can be observed. Returns the negotiated initialization info.",
      inputSchema: z.object({
        name: z
          .string()
          .optional()
          .describe(
            "Connection name used by the other tools. Defaults to the URL hostname or command basename.",
          ),
        ...targetConfigFields,
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (input) =>
      runTool(async () => {
        const { config } = buildTargetConfig(input, defaultTimeoutMs);
        const requestedName = input.name?.trim();
        if (requestedName && manager.hasServer(requestedName)) {
          throw usageError(
            `A connection named "${requestedName}" already exists. Disconnect it first or pick another name.`,
          );
        }
        const name =
          requestedName ??
          deriveServerName(input, (candidate) => manager.hasServer(candidate));

        await manager.connectToServer(name, config);
        watchNotifications(name);

        return {
          server: name,
          status: manager.getConnectionStatus(name),
          initialization: manager.getInitializationInfo(name) ?? null,
        };
      }),
  );

  server.registerTool(
    "disconnect_server",
    {
      title: "Disconnect from an MCP server",
      description:
        "Close an open connection created by connect_server and discard its buffered notifications.",
      inputSchema: z.object({
        server: z.string().describe("Connection name from connect_server"),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ server: name }) =>
      runTool(async () => {
        if (!manager.hasServer(name)) {
          throw usageError(`Unknown server "${name}".`);
        }
        await manager.removeServer(name);
        for (let index = notifications.length - 1; index >= 0; index -= 1) {
          if (notifications[index].server === name) {
            notifications.splice(index, 1);
          }
        }
        return { server: name, status: "disconnected" };
      }),
  );

  server.registerTool(
    "list_servers",
    {
      title: "List open connections",
      description:
        "List the MCP server connections opened with connect_server, with status and a redacted target summary.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      runTool(async () => ({
        servers: manager.listServers().map(describeServer),
      })),
  );

  server.registerTool(
    "server_info",
    {
      title: "Get server initialization info",
      description:
        "Get the negotiated initialization info for a connected server: protocol version, transport, server info/version, capabilities, and instructions.",
      inputSchema: z.object({
        server: z.string().describe("Connection name from connect_server"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ server: name }) =>
      runTool(async () => {
        requireConnected(name);
        return {
          server: name,
          initialization: manager.getInitializationInfo(name) ?? null,
        };
      }),
  );

  server.registerTool(
    "ping_server",
    {
      title: "Ping a connected server",
      description:
        "Send an MCP ping over an open connection and report the round-trip latency.",
      inputSchema: z.object({
        server: z.string().describe("Connection name from connect_server"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ server: name }) =>
      runTool(async () => {
        requireConnected(name);
        const startedAt = Date.now();
        await manager.pingServer(name);
        return {
          server: name,
          status: "ok",
          latencyMs: Date.now() - startedAt,
        };
      }),
  );

  server.registerTool(
    "list_tools",
    {
      title: "List the target server's tools",
      description:
        "List tools exposed by a connected server, including pagination cursor and per-tool metadata.",
      inputSchema: z.object({
        server: z.string().describe("Connection name from connect_server"),
        cursor: z.string().optional().describe("Pagination cursor"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ server: name, cursor }) =>
      runTool(async () => {
        requireConnected(name);
        return listToolsWithMetadata(manager, { serverId: name, cursor });
      }),
  );

  server.registerTool(
    "call_tool",
    {
      title: "Call a tool on the target server",
      description:
        "Invoke a tool on a connected server and return the target's raw CallToolResult. A tool-level failure is reported inside the payload via its \"isError\" field; this call only errors when the request itself fails.",
      inputSchema: z.object({
        server: z.string().describe("Connection name from connect_server"),
        tool: z.string().describe("Tool name on the target server"),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Tool arguments object"),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ server: name, tool, arguments: args }) =>
      runTool(async () => {
        requireConnected(name);
        return manager.executeTool(name, tool, args ?? {});
      }),
  );

  server.registerTool(
    "list_resources",
    {
      title: "List the target server's resources",
      description:
        "List resources exposed by a connected server. Set templates=true to list resource templates instead.",
      inputSchema: z.object({
        server: z.string().describe("Connection name from connect_server"),
        cursor: z.string().optional().describe("Pagination cursor"),
        templates: z
          .boolean()
          .optional()
          .describe("List resource templates instead of resources"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ server: name, cursor, templates }) =>
      runTool(async () => {
        requireConnected(name);
        const params = cursor ? { cursor } : undefined;
        return templates
          ? manager.listResourceTemplates(name, params)
          : manager.listResources(name, params);
      }),
  );

  server.registerTool(
    "read_resource",
    {
      title: "Read a resource from the target server",
      description: "Read a resource from a connected server by URI.",
      inputSchema: z.object({
        server: z.string().describe("Connection name from connect_server"),
        uri: z.string().describe("Resource URI to read"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ server: name, uri }) =>
      runTool(async () => {
        requireConnected(name);
        return manager.readResource(name, { uri });
      }),
  );

  server.registerTool(
    "list_prompts",
    {
      title: "List the target server's prompts",
      description: "List prompts exposed by a connected server.",
      inputSchema: z.object({
        server: z.string().describe("Connection name from connect_server"),
        cursor: z.string().optional().describe("Pagination cursor"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ server: name, cursor }) =>
      runTool(async () => {
        requireConnected(name);
        return manager.listPrompts(name, cursor ? { cursor } : undefined);
      }),
  );

  server.registerTool(
    "get_prompt",
    {
      title: "Get a prompt from the target server",
      description:
        "Fetch a named prompt from a connected server, optionally with string arguments.",
      inputSchema: z.object({
        server: z.string().describe("Connection name from connect_server"),
        prompt: z.string().describe("Prompt name on the target server"),
        arguments: z
          .record(z.string(), z.string())
          .optional()
          .describe("Prompt arguments (string values)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ server: name, prompt, arguments: args }) =>
      runTool(async () => {
        requireConnected(name);
        return manager.getPrompt(name, {
          name: prompt,
          ...(args ? { arguments: args } : {}),
        });
      }),
  );

  server.registerTool(
    "get_notifications",
    {
      title: "Get buffered notifications",
      description:
        "Return notifications received from connected servers since connect (log messages, progress, tools/resources/prompts list_changed, resource updates). Use after call_tool or a server-side change to verify the target emitted the expected notifications.",
      inputSchema: z.object({
        server: z
          .string()
          .optional()
          .describe("Only return notifications from this connection"),
        method: z
          .string()
          .optional()
          .describe('Only return this method, e.g. "notifications/message"'),
        clear: z
          .boolean()
          .optional()
          .describe("Remove the returned notifications from the buffer"),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ server: name, method, clear }) =>
      runTool(async () => {
        const matches = notifications.filter(
          (entry) =>
            (!name || entry.server === name) &&
            (!method || entry.method === method),
        );
        if (clear) {
          for (const entry of matches) {
            const index = notifications.indexOf(entry);
            if (index !== -1) {
              notifications.splice(index, 1);
            }
          }
        }
        return {
          notifications: matches,
          buffered: notifications.length,
          droppedOverflow: droppedNotifications,
        };
      }),
  );

  server.registerTool(
    "server_doctor",
    {
      title: "Run a diagnostic sweep",
      description:
        "Run a stateless diagnostic sweep against an MCP server (HTTP url or stdio command) without keeping a connection open: reachability, initialize, capability checks, and tool/resource/prompt counts. Equivalent to `mcpjam server doctor`.",
      inputSchema: z.object(targetConfigFields),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) =>
      runTool(async () => {
        const { config, target } = buildTargetConfig(input, defaultTimeoutMs);
        const result = await runServerDoctor({
          config,
          target: summarizeServerDoctorTarget(target, config),
          timeout: input.timeoutMs ?? defaultTimeoutMs,
        });
        return redactSensitiveValue(result);
      }),
  );

  server.registerTool(
    "probe_server",
    {
      title: "Probe an HTTP server",
      description:
        "Probe an HTTP MCP server without the full client connect flow: transport selection, auth requirements, and OAuth metadata discovery. Equivalent to `mcpjam server probe`.",
      inputSchema: z.object({
        url: z.string().describe("HTTP(S) MCP server URL"),
        accessToken: z
          .string()
          .optional()
          .describe("Bearer access token to probe with"),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Extra HTTP headers"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Request timeout in milliseconds"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, accessToken, headers, timeoutMs }) =>
      runTool(async () => {
        try {
          new URL(url);
        } catch {
          throw usageError(`Invalid URL: ${url}`);
        }
        const result = await probeMcpServer({
          url,
          accessToken,
          headers,
          timeoutMs: timeoutMs ?? defaultTimeoutMs,
        });
        return redactSensitiveValue(result);
      }),
  );

  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    await manager.disconnectAllServers().catch(() => undefined);
    await server.close().catch(() => undefined);
  };

  return { server, manager, close };
}
