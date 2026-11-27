// beta.4 moved the stdio server transport to the `/stdio` subpath.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { createMcpJamMcpServer } from "../lib/mcp-server.js";
import { recordCommandOutcome } from "../lib/command-outcome.js";
import { getGlobalOptions } from "../lib/server-config.js";
import { captureMcpToolEvent } from "../lib/telemetry.js";

export function registerMcpCommands(program: Command): void {
  program
    .command("mcp")
    .description(
      "Run MCPJam as an MCP server over stdio, so MCP clients (Claude Desktop, Claude Code, Cursor, ...) can connect to, exercise, and debug other MCP servers",
    )
    .option(
      "--evals",
      "Also serve MCPJam's eval tools and their skill, signed in with your MCPJam login (mcpjam cloud login, or MCPJAM_API_KEY in this server's env)",
    )
    .action(async (options: { evals?: boolean }, command) => {
      const globalOptions = getGlobalOptions(command);
      const handle = createMcpJamMcpServer({
        version: packageJson.version,
        defaultTimeoutMs: globalOptions.timeout,
        onToolCalled: captureMcpToolEvent,
        evals: options.evals === true,
      });

      const transport = new StdioServerTransport();
      let resolveClosed!: () => void;
      const stopOnSignal = () => {
        recordCommandOutcome("interrupted");
        resolveClosed();
      };
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
        handle.server.server.onclose = resolve;
        process.once("SIGINT", stopOnSignal);
        process.once("SIGTERM", stopOnSignal);
      });

      try {
        await handle.server.connect(transport);

        if (!globalOptions.quiet) {
          // stdout carries JSON-RPC in this mode; status goes to stderr only.
          process.stderr.write("MCPJam CLI MCP server listening on stdio\n");
        }

        await closed;
      } finally {
        process.off("SIGINT", stopOnSignal);
        process.off("SIGTERM", stopOnSignal);
        await handle.close();
      }
    });
}
