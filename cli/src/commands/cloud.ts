import type { Command } from "commander";
import { addPlatformOptions } from "../lib/platform-command.js";
import { registerAuthCommands } from "./auth.js";
import { registerCloudLinkCommands } from "./cloud-link.js";
import { registerEnvironmentsCommands } from "./environments.js";
import { registerEvalCommands } from "./eval.js";
import { registerClientsCommands } from "./clients.js";
import { registerImagesCommands } from "./images.js";
import { registerSkillsCommands } from "./skills.js";
import { registerJourneysCommands } from "./journeys.js";
import { registerOrganizationsCommands } from "./organizations.js";
import { registerProjectsCommands } from "./projects.js";
import { registerScenariosCommands } from "./scenarios.js";
import { registerSecretsCommands } from "./secrets.js";
import { registerSessionsCommands } from "./sessions.js";
import { registerSwarmAuthoringCommands } from "./swarms.js";
import { registerTraceDestinationsCommands } from "./trace-destinations.js";
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

  cloud.commandsGroup("Account:");
  registerAuthCommands(cloud);
  registerCloudLinkCommands(cloud);

  cloud.commandsGroup("Workspace:");
  registerOrganizationsCommands(cloud);
  registerProjectsCommands(cloud);
  registerSessionsCommands(cloud);
  registerTunnelCommands(cloud);

  cloud.commandsGroup("Eval and environments:");
  registerEvalCommands(cloud);
  registerClientsCommands(cloud);
  registerEnvironmentsCommands(cloud);
  // Project secrets sit with environments because an environment is what grants
  // one to a run — you create a secret here and then select it there.
  registerSecretsCommands(cloud);
  registerImagesCommands(cloud);
  registerSkillsCommands(cloud);

  cloud.commandsGroup("Observability:");
  // Organization-scoped, not project-scoped: a destination is a vendor binding
  // the whole organization streams through, and the project allowlist is a
  // filter on it rather than its owner.
  registerTraceDestinationsCommands(cloud);

  cloud.commandsGroup("Swarms and user testing:");
  const journeys = registerJourneysCommands(cloud);
  registerScenariosCommands(cloud);
  registerSwarmAuthoringCommands(cloud, journeys);
  registerUserTestingCommands(cloud);
  return cloud;
}
