import type { Command } from "commander";
import { addPlatformOptions } from "../lib/platform-command.js";
import { registerAuthCommands } from "./auth.js";
import { registerChatCommands } from "./chat.js";
import { registerCloudLinkCommands } from "./cloud-link.js";
import { registerEnvironmentsCommands } from "./environments.js";
import { registerEvalCommands } from "./eval.js";
import { registerHostsCommands } from "./hosts.js";
import { registerImagesCommands } from "./images.js";
import { registerJourneysCommands } from "./journeys.js";
import { registerOrganizationsCommands } from "./organizations.js";
import { registerProjectsCommands } from "./projects.js";
import { registerScenariosCommands } from "./scenarios.js";
import { registerSessionsCommands } from "./sessions.js";
import { registerSwarmAuthoringCommands } from "./swarms.js";
import { registerTunnelCommands } from "./tunnel.js";
import { registerUserTestingCommands } from "./user-testing.js";

/**
 * Account-bound MCPJam Cloud commands. Local MCP testing stays at the program
 * root (`mcpjam server`, `mcpjam oauth login`, …). There are no compatibility
 * aliases for the old root paths.
 */
export function registerCloudCommands(program: Command): Command {
  const cloud = program
    .command("cloud")
    .description(
      "MCPJam Cloud account commands (login, projects, evals, tunnels). Local MCP testing stays at the top level — `mcpjam oauth login` is MCP OAuth; `mcpjam cloud login` is your MCPJam account."
    );

  addPlatformOptions(cloud);

  registerAuthCommands(cloud);
  registerCloudLinkCommands(cloud);
  registerOrganizationsCommands(cloud);
  registerProjectsCommands(cloud);
  registerEvalCommands(cloud);
  registerChatCommands(cloud);
  registerSessionsCommands(cloud);
  registerHostsCommands(cloud);
  registerEnvironmentsCommands(cloud);
  const journeys = registerJourneysCommands(cloud);
  registerScenariosCommands(cloud);
  registerSwarmAuthoringCommands(cloud, journeys);
  registerUserTestingCommands(cloud);
  registerImagesCommands(cloud);
  registerTunnelCommands(cloud);
  return cloud;
}
