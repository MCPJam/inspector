import type { Command } from "commander";
import chalk from "chalk";
import { withServer } from "../client.js";

interface GlobalOptions {
  json?: boolean;
  quiet?: boolean;
}

interface ResourcesCommandOptions extends GlobalOptions {
  server: string;
}

export function registerResourcesCommand(program: Command): void {
  const resources = program
    .command("resources")
    .description("Manage MCP server resources");

  resources
    .command("list")
    .description("List available resources from an MCP server")
    .requiredOption("-s, --server <command|url>", "Server command or URL")
    .action(async (options: ResourcesCommandOptions) => {
      const globalOpts = program.opts<GlobalOptions>();

      try {
        const result = await withServer(options.server, async (manager, serverId) => {
          return await manager.listResources(serverId);
        });

        if (globalOpts.json) {
          console.log(JSON.stringify(result.resources, null, 2));
        } else {
          if (result.resources.length === 0) {
            console.log(chalk.yellow("No resources available"));
            return;
          }

          // Calculate column widths
          const uriWidth = Math.max(30, ...result.resources.map((r) => r.uri.length));
          const nameWidth = Math.max(20, ...result.resources.map((r) => (r.name || "").length));

          // Header
          console.log(
            chalk.bold("URI".padEnd(uriWidth)) +
              "  " +
              chalk.bold("NAME".padEnd(nameWidth)) +
              "  " +
              chalk.bold("MIME TYPE")
          );

          // Resources
          for (const resource of result.resources) {
            const uri = resource.uri.padEnd(uriWidth);
            const name = (resource.name || chalk.dim("-")).toString().padEnd(nameWidth);
            const mimeType = resource.mimeType || chalk.dim("-");
            console.log(`${uri}  ${name}  ${mimeType}`);
          }
        }
      } catch (error) {
        console.error(chalk.red("Error:"), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  resources
    .command("read <uri>")
    .description("Read a resource by URI")
    .requiredOption("-s, --server <command|url>", "Server command or URL")
    .action(async (uri: string, options: ResourcesCommandOptions) => {
      const globalOpts = program.opts<GlobalOptions>();

      try {
        const result = await withServer(options.server, async (manager, serverId) => {
          return await manager.readResource(serverId, { uri });
        });

        if (globalOpts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          // Display contents
          for (const content of result.contents) {
            if ("text" in content) {
              console.log(content.text);
            } else if ("blob" in content) {
              console.log(chalk.dim(`[Binary data: ${content.mimeType || "unknown type"}]`));
            }
          }
        }
      } catch (error) {
        console.error(chalk.red("Error:"), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  resources
    .command("templates")
    .description("List resource templates from an MCP server")
    .requiredOption("-s, --server <command|url>", "Server command or URL")
    .action(async (options: ResourcesCommandOptions) => {
      const globalOpts = program.opts<GlobalOptions>();

      try {
        const result = await withServer(options.server, async (manager, serverId) => {
          return await manager.listResourceTemplates(serverId);
        });

        if (globalOpts.json) {
          console.log(JSON.stringify(result.resourceTemplates, null, 2));
        } else {
          if (result.resourceTemplates.length === 0) {
            console.log(chalk.yellow("No resource templates available"));
            return;
          }

          // Calculate column widths
          const uriTemplateWidth = Math.max(
            40,
            ...result.resourceTemplates.map((t) => t.uriTemplate.length)
          );
          const nameWidth = Math.max(
            20,
            ...result.resourceTemplates.map((t) => (t.name || "").length)
          );

          // Header
          console.log(
            chalk.bold("URI TEMPLATE".padEnd(uriTemplateWidth)) +
              "  " +
              chalk.bold("NAME".padEnd(nameWidth)) +
              "  " +
              chalk.bold("DESCRIPTION")
          );

          // Templates
          for (const template of result.resourceTemplates) {
            const uriTemplate = template.uriTemplate.padEnd(uriTemplateWidth);
            const name = (template.name || chalk.dim("-")).toString().padEnd(nameWidth);
            const desc = template.description || chalk.dim("(no description)");
            console.log(`${uriTemplate}  ${name}  ${desc}`);
          }
        }
      } catch (error) {
        console.error(chalk.red("Error:"), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}
