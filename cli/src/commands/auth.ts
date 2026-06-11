import type { Command } from "commander";
import { getGlobalOptions } from "../lib/server-config.js";
import { writeResult } from "../lib/output.js";
import {
  runPlatformLogin,
  runPlatformLogout,
} from "../lib/platform-auth.js";
import {
  buildPlatformClient,
  resolvePlatformOrigin,
  toCliError,
} from "../lib/platform-client.js";

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description(
      "Log in to MCPJam. Opens your browser for OAuth and stores the session locally.",
    )
    .option(
      "--api-url <url>",
      "MCPJam API base URL (defaults to https://app.mcpjam.com/api/v1)",
    )
    .option(
      "--no-browser",
      "Print the login URL instead of opening a browser",
    )
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const origin = resolvePlatformOrigin(options);

      const result = await runPlatformLogin(origin, {
        ...(options.browser === false
          ? {
              openUrl: async (url: string) => {
                process.stderr.write(
                  `Open this URL in your browser to continue:\n\n  ${url}\n\n`,
                );
              },
            }
          : {}),
      });

      writeResult(
        {
          status: "logged_in",
          issuer: result.issuer,
          authFile: result.authFilePath,
          ...(result.expiresAt !== undefined
            ? { expiresAt: new Date(result.expiresAt).toISOString() }
            : {}),
        },
        globalOptions.format,
      );
    });

  program
    .command("logout")
    .description("Remove the stored MCPJam login.")
    .action(async (_options, command) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformLogout();

      writeResult(
        {
          status: result.loggedOut ? "logged_out" : "not_logged_in",
          authFile: result.authFilePath,
        },
        globalOptions.format,
      );
    });

  program
    .command("whoami")
    .description("Show the MCPJam account behind the current credentials.")
    .option("--api-key <key>", "MCPJam sk_ API key (overrides MCPJAM_API_KEY)")
    .option(
      "--api-url <url>",
      "MCPJam API base URL (defaults to https://app.mcpjam.com/api/v1)",
    )
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);

      try {
        const { client, credentialKind } = buildPlatformClient(options);
        const me = await client.getMe();

        writeResult(
          {
            id: me.id,
            email: me.email,
            name: me.name,
            ...(me.plan ? { plan: me.plan } : {}),
            credential: credentialKind,
          },
          globalOptions.format,
        );
      } catch (error) {
        throw toCliError(error);
      }
    });
}
