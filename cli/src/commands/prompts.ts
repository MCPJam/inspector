import type { Command } from "commander";
import chalk from "chalk";
import { withServer } from "../client.js";

interface GlobalOptions {
  json?: boolean;
  quiet?: boolean;
}

interface PromptsCommandOptions extends GlobalOptions {
  server: string;
}

export function registerPromptsCommand(program: Command): void {
  const prompts = program.command("prompts").description("Manage MCP server prompts");

  prompts
    .command("list")
    .description("List available prompts from an MCP server")
    .requiredOption("-s, --server <command|url>", "Server command or URL")
    .action(async (options: PromptsCommandOptions) => {
      const globalOpts = program.opts<GlobalOptions>();

      try {
        const result = await withServer(options.server, async (manager, serverId) => {
          return await manager.listPrompts(serverId);
        });

        if (globalOpts.json) {
          console.log(JSON.stringify(result.prompts, null, 2));
        } else {
          if (result.prompts.length === 0) {
            console.log(chalk.yellow("No prompts available"));
            return;
          }

          // Calculate column widths
          const nameWidth = Math.max(20, ...result.prompts.map((p) => p.name.length));

          // Header
          console.log(chalk.bold("NAME".padEnd(nameWidth)) + "  " + chalk.bold("DESCRIPTION"));

          // Prompts
          for (const prompt of result.prompts) {
            const name = prompt.name.padEnd(nameWidth);
            const desc = prompt.description || chalk.dim("(no description)");
            console.log(`${name}  ${desc}`);
          }
        }
      } catch (error) {
        console.error(chalk.red("Error:"), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  prompts
    .command("get <name> [args]")
    .description("Get a prompt with optional arguments (JSON format)")
    .requiredOption("-s, --server <command|url>", "Server command or URL")
    .action(async (name: string, argsJson: string | undefined, options: PromptsCommandOptions) => {
      const globalOpts = program.opts<GlobalOptions>();

      try {
        // Parse args if provided
        let args: Record<string, string> | undefined;
        if (argsJson) {
          try {
            args = JSON.parse(argsJson);
          } catch {
            console.error(chalk.red("Error:"), "Invalid JSON arguments");
            process.exit(1);
          }
        }

        const result = await withServer(options.server, async (manager, serverId) => {
          return await manager.getPrompt(serverId, { name, arguments: args });
        });

        if (globalOpts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          // Display description if present
          if (result.description) {
            console.log(chalk.bold("Description:"), result.description);
            console.log();
          }

          // Display messages
          console.log(chalk.bold("Messages:"));
          for (const message of result.messages) {
            console.log(chalk.cyan(`[${message.role}]`));
            if (typeof message.content === "string") {
              console.log(message.content);
            } else if ("text" in message.content) {
              console.log(message.content.text);
            } else if ("type" in message.content) {
              if (message.content.type === "text") {
                console.log(message.content.text);
              } else if (message.content.type === "image") {
                console.log(chalk.dim(`[Image: ${message.content.mimeType}]`));
              } else if (message.content.type === "resource") {
                console.log(chalk.dim(`[Resource: ${message.content.resource.uri}]`));
              }
            }
            console.log();
          }
        }
      } catch (error) {
        console.error(chalk.red("Error:"), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}
