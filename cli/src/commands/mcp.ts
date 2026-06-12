import { StdioServerTransport } from "@modelcontextprotocol/server";
import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { createMcpJamMcpServer } from "../lib/mcp-server.js";
import { getGlobalOptions } from "../lib/server-config.js";

export function registerMcpCommands(program: Command): void {
  program
    .command("mcp")
    .description(
      "Run MCPJam as an MCP server over stdio, so MCP clients (Claude Desktop, Claude Code, Cursor, ...) can connect to, exercise, and debug other MCP servers",
    )
    .action(async (_options, command) => {
      const globalOptions = getGlobalOptions(command);
      const handle = createMcpJamMcpServer({
        version: packageJson.version,
        defaultTimeoutMs: globalOptions.timeout,
      });

      const transport = new StdioServerTransport();
      const closed = new Promise<void>((resolve) => {
        handle.server.server.onclose = resolve;
        const stopOnSignal = () => resolve();
        process.once("SIGINT", stopOnSignal);
        process.once("SIGTERM", stopOnSignal);
      });

      await handle.server.connect(transport);

      if (!globalOptions.quiet) {
        // stdout carries JSON-RPC in this mode; status goes to stderr only.
        process.stderr.write("MCPJam MCP server listening on stdio\n");
      }

      await closed;
      await handle.close();
    });
}
