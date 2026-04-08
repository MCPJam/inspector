import type { Command } from "commander";
import chalk from "chalk";
import { withServer } from "../client.js";

interface GlobalOptions {
  json?: boolean;
  quiet?: boolean;
}

interface ServerCommandOptions extends GlobalOptions {
  server: string;
}

export function registerServerCommand(program: Command): void {
  const server = program.command("server").description("MCP server management");

  server
    .command("info")
    .description("Show server capabilities and info")
    .requiredOption("-s, --server <command|url>", "Server command or URL")
    .action(async (options: ServerCommandOptions) => {
      const globalOpts = program.opts<GlobalOptions>();

      try {
        const result = await withServer(options.server, async (manager, serverId) => {
          const info = manager.getInitializationInfo(serverId);
          const capabilities = manager.getServerCapabilities(serverId);
          return { info, capabilities };
        });

        if (globalOpts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const { info, capabilities } = result;

          if (info) {
            console.log(chalk.bold("Server Information"));
            console.log("─".repeat(40));

            if (info.serverVersion) {
              console.log(
                `${chalk.dim("Name:")}          ${info.serverVersion.name || chalk.dim("-")}`
              );
              console.log(
                `${chalk.dim("Version:")}       ${info.serverVersion.version || chalk.dim("-")}`
              );
            }

            console.log(`${chalk.dim("Transport:")}     ${info.transport || chalk.dim("-")}`);
            console.log(
              `${chalk.dim("Protocol:")}      ${info.protocolVersion || chalk.dim("-")}`
            );

            if (info.instructions) {
              console.log(`${chalk.dim("Instructions:")}  ${info.instructions}`);
            }
          }

          if (capabilities) {
            console.log();
            console.log(chalk.bold("Capabilities"));
            console.log("─".repeat(40));

            const capList: string[] = [];

            if (capabilities.tools) {
              capList.push("tools");
            }
            if (capabilities.resources) {
              capList.push("resources");
              if (capabilities.resources.subscribe) {
                capList.push("resources.subscribe");
              }
              if (capabilities.resources.listChanged) {
                capList.push("resources.listChanged");
              }
            }
            if (capabilities.prompts) {
              capList.push("prompts");
              if (capabilities.prompts.listChanged) {
                capList.push("prompts.listChanged");
              }
            }
            if (capabilities.logging) {
              capList.push("logging");
            }
            if (capabilities.experimental) {
              for (const key of Object.keys(capabilities.experimental)) {
                capList.push(`experimental.${key}`);
              }
            }

            if (capList.length > 0) {
              for (const cap of capList) {
                console.log(`  ${chalk.green("✓")} ${cap}`);
              }
            } else {
              console.log(chalk.dim("  No capabilities reported"));
            }
          }
        }
      } catch (error) {
        console.error(chalk.red("Error:"), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  server
    .command("ping")
    .description("Ping server to check connectivity")
    .requiredOption("-s, --server <command|url>", "Server command or URL")
    .action(async (options: ServerCommandOptions) => {
      const globalOpts = program.opts<GlobalOptions>();

      try {
        const startTime = Date.now();
        await withServer(options.server, async (manager, serverId) => {
          manager.pingServer(serverId);
        });
        const elapsed = Date.now() - startTime;

        if (globalOpts.json) {
          console.log(JSON.stringify({ success: true, elapsed_ms: elapsed }, null, 2));
        } else {
          console.log(chalk.green("✓"), `Server is reachable (${elapsed}ms)`);
        }
      } catch (error) {
        if (globalOpts.json) {
          console.log(
            JSON.stringify(
              {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2
            )
          );
        } else {
          console.error(chalk.red("✗"), "Server ping failed");
          console.error(chalk.red("Error:"), error instanceof Error ? error.message : error);
        }
        process.exit(1);
      }
    });
}
