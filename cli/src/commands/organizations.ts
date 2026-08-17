/**
 * `mcpjam organizations` — the read half, which is the whole group.
 *
 * It exists because an `organizationId` had nowhere to come from. `projects
 * list --organization` and `projects create --organization-id` both take one,
 * and until now the only way to learn one was to read it out of a browser URL.
 *
 * Deliberately list-only. Creating an organization, inviting or removing
 * members, changing roles, transferring ownership and everything billing stay
 * in the app: they are account administration, not scripting, and no
 * enterprise CLI of this shape ships them behind an API key either.
 */
import type { Command } from "commander";
import {
  listOrganizationsOperation,
  PlatformApiError,
} from "@mcpjam/sdk/platform";
import { writeResult } from "../lib/output.js";
import { formatOrganizationsHuman } from "../lib/projects-render.js";
import { buildPlatformClient, toCliError } from "../lib/platform-client.js";
import { getGlobalOptions } from "../lib/server-config.js";

type PlatformOptions = {
  apiKey?: string;
  apiUrl?: string;
};

function addPlatformOptions(command: Command): Command {
  return command
    .option("--api-key <key>", "MCPJam sk_ API key (overrides MCPJAM_API_KEY)")
    .option(
      "--api-url <url>",
      "MCPJam API base URL (defaults to https://app.mcpjam.com/api/v1)",
    );
}

async function runPlatformCommand<TOutput>(
  options: PlatformOptions,
  timeoutMs: number,
  execute: (context: {
    client: ReturnType<typeof buildPlatformClient>["client"];
    signal: AbortSignal;
  }) => Promise<TOutput>,
): Promise<TOutput> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort(
      new PlatformApiError(`Request timed out after ${timeoutMs}ms`, "TIMEOUT", {
        status: 0,
      }),
    );
  }, timeoutMs);
  timeoutHandle.unref?.();

  try {
    const { client } = buildPlatformClient({ ...options, timeoutMs });
    return await execute({ client, signal: controller.signal });
  } catch (error) {
    // When OUR deadline fired, surface the armed TIMEOUT error rather than the
    // bare AbortError some fetch implementations reject with.
    if (
      controller.signal.aborted &&
      controller.signal.reason instanceof PlatformApiError
    ) {
      throw toCliError(controller.signal.reason);
    }
    throw toCliError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export function registerOrganizationsCommands(program: Command): void {
  const organizations = program
    .command("organizations")
    .alias("orgs")
    .description("Inspect the MCPJam organizations you belong to");

  addPlatformOptions(
    organizations
      .command("list")
      .description(
        "List your organizations and their ids (an sk_ key sees only its own)",
      ),
    // `--api-key` / `--api-url` are declared only here, not on the group, so
    // Commander hands them to this action directly — no `optsWithGlobals`
    // merge dance like `projects`, whose `servers` group duplicates them.
  ).action(async (options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        listOrganizationsOperation.execute({}, { client, signal }),
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
