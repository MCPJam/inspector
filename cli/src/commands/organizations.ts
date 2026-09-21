/**
 * `mcpjam cloud organizations` — the read half, which is the whole group.
 *
 * It exists because an `organizationId` had nowhere to come from. `projects
 * list --org` and `projects create --org` both take one, and until now the
 * only way to learn one was to read it out of a browser URL.
 *
 * Deliberately list-only. Creating an organization, inviting or removing
 * members, changing roles, transferring ownership and everything billing stay
 * in the app: they are account administration, not scripting, and no
 * enterprise CLI of this shape ships them behind an API key either.
 */
import type { Command } from "commander";
import {
  listOrganizationsOperation,
} from "@mcpjam/sdk/platform";
import { writeResult } from "../lib/output.js";
import { formatOrganizationsHuman } from "../lib/projects-render.js";
import {
  platformOptionsOf,
  runPlatformOperation as runPlatformCommand,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { getGlobalOptions } from "../lib/server-config.js";




export function registerOrganizationsCommands(program: Command): void {
  const organizations = program
    .command("organizations")
    .alias("orgs")
    .description("Inspect the MCPJam organizations you belong to");

  organizations
    .command("list")
    .description(
      "List your organizations and their ids (an sk_ key sees only its own)",
    )
    .action(async (_options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      platformOptionsOf(command),
      globalOptions.timeout,
      ({ client, signal }) =>
        listOrganizationsOperation.execute({}, { client, signal }),
      { cloudScope: { kind: "account" }, quiet: globalOptions.quiet },
    );

    if (globalOptions.format === "human") {
      process.stdout.write(`${formatOrganizationsHuman(result.items)}\n`);
    } else {
      // Operation payload verbatim, pagination fields and all — same contract
      // as `projects list` and the `list_organizations` MCP tool.
      writeResult(result, globalOptions.format);
    }
  });
}
