import type { Command } from "commander";
import chalk from "chalk";
import { withServer } from "../client.js";

interface GlobalOptions {
  json?: boolean;
  quiet?: boolean;
}

interface ToolsCommandOptions extends GlobalOptions {
  server: string;
}

export function registerToolsCommand(program: Command): void {
  const tools = program.command("tools").description("Manage MCP server tools");

  tools
    .command("list")
    .description("List available tools from an MCP server")
    .requiredOption("-s, --server <command|url>", "Server command or URL")
    .action(async (options: ToolsCommandOptions) => {
      const globalOpts = program.opts<GlobalOptions>();

      try {
        const result = await withServer(options.server, async (manager, serverId) => {
          return await manager.listTools(serverId);
        });

        if (globalOpts.json) {
          console.log(JSON.stringify(result.tools, null, 2));
        } else {
          if (result.tools.length === 0) {
            console.log(chalk.yellow("No tools available"));
            return;
          }

          // Calculate column widths
          const nameWidth = Math.max(
            20,
            ...result.tools.map((t) => t.name.length)
          );

          // Header
          console.log(
            chalk.bold("TOOL".padEnd(nameWidth)) + "  " + chalk.bold("DESCRIPTION")
          );

          // Tools
          for (const tool of result.tools) {
            const name = tool.name.padEnd(nameWidth);
            const desc = tool.description || chalk.dim("(no description)");
            console.log(`${name}  ${desc}`);
          }
        }
      } catch (error) {
        console.error(chalk.red("Error:"), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  tools
    .command("call <name> [args]")
    .description("Call a tool on an MCP server")
    .requiredOption("-s, --server <command|url>", "Server command or URL")
    .action(async (name: string, argsJson: string | undefined, options: ToolsCommandOptions) => {
      const globalOpts = program.opts<GlobalOptions>();

      try {
        // Parse args if provided
        let args: Record<string, unknown> = {};
        if (argsJson) {
          try {
            args = JSON.parse(argsJson);
          } catch {
            console.error(chalk.red("Error:"), "Invalid JSON arguments");
            process.exit(1);
          }
        }

        const result = await withServer(options.server, async (manager, serverId) => {
          return await manager.executeTool(serverId, name, args);
        });

        // Handle task results (experimental MCP feature)
        if ("task" in result) {
          if (globalOpts.json) {
            console.log(JSON.stringify(result.task, null, 2));
          } else {
            console.log(chalk.yellow("Task started:"), result.task.id);
          }
          return;
        }

        // Regular tool result
        if (globalOpts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          // Display content array
          for (const content of result.content) {
            if (content.type === "text") {
              console.log(content.text);
            } else if (content.type === "image") {
              console.log(chalk.dim(`[Image: ${content.mimeType}]`));
            } else if (content.type === "resource") {
              console.log(chalk.dim(`[Resource: ${content.resource.uri}]`));
            } else {
              console.log(chalk.dim(`[Unknown content type]`));
            }
          }

          // Show error indicator if tool returned an error
          if (result.isError) {
            console.error(chalk.red("\nTool returned an error"));
            process.exit(1);
          }
        }
      } catch (error) {
        console.error(chalk.red("Error:"), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}
