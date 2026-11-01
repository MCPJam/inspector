import { z } from "zod/v4";
import type { HarnessMcpJson } from "../../mcp-config.js";
import { RELAY_MCP_SERVER_NAME } from "./tool-names.js";

export const nativeMcpServersSchema = z.record(
  z.string(),
  z
    .object({
      type: z.literal("http"),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).optional(),
      timeout: z.number().finite().positive().optional(),
    })
    .strict(),
);

export function refreshNativeMcpServers(
  current: HarnessMcpJson["mcpServers"],
  candidate: unknown,
) {
  const next = nativeMcpServersSchema.parse(candidate);
  if (
    JSON.stringify(Object.keys(current).sort()) !==
    JSON.stringify(Object.keys(next).sort())
  ) {
    throw new Error(
      "The forwarded server selection changed while the turn was pending.",
    );
  }
  return Object.fromEntries(
    Object.entries(current).map(([key, prior]) => {
      const entry = next[key];
      if (
        entry.url !== prior.url ||
        !entry.headers ||
        Object.keys(entry.headers).length !== 2 ||
        entry.headers.Connection !== "close" ||
        typeof entry.headers["X-MCPJam-Forwarding-Context"] !== "string" ||
        entry.headers["X-MCPJam-Forwarding-Context"].length > 32768
      ) {
        throw new Error(
          "The pending forwarding configuration cannot be replaced.",
        );
      }
      return [key, { ...prior, headers: entry.headers }] as const;
    }),
  );
}

export function renderCodexNativeMcpServers(input: HarnessMcpJson): string[] {
  return Object.entries(codexNativeMcpServers(input)).flatMap(
    ([name, config]) => [
      "",
      `[mcp_servers.${JSON.stringify(name)}]`,
      `url = ${JSON.stringify(config.url)}`,
      "enabled = true",
      "startup_timeout_sec = 30",
      `tool_timeout_sec = ${config.tool_timeout_sec}`,
      'default_tools_approval_mode = "approve"',
      `http_headers = { ${Object.entries(config.http_headers)
        .map(
          ([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`,
        )
        .join(", ")} }`,
    ],
  );
}

/** Convert only the host-authorized per-server routes, never an upstream credential. */
export function codexNativeMcpServers(input: HarnessMcpJson) {
  return Object.fromEntries(
    Object.entries(input.mcpServers).map(([name, server]) => {
      if (name === RELAY_MCP_SERVER_NAME) {
        throw new Error(
          "A forwarded server cannot replace the host-tool relay.",
        );
      }
      const url = new URL(server.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      ) {
        throw new Error(
          "A forwarded MCP server requires an HTTP endpoint without URL credentials.",
        );
      }
      return [
        name,
        {
          url: server.url,
          http_headers: { ...server.headers },
          enabled: true,
          startup_timeout_sec: 30,
          tool_timeout_sec: Math.max(
            1,
            Math.ceil((server.timeout ?? 300_000) / 1000),
          ),
          // Approval happens at MCPJam's execution gate for these routes.
          default_tools_approval_mode: "approve",
        },
      ] as const;
    }),
  );
}
