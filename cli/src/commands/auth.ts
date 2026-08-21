import type { Command } from "commander";
import { getGlobalOptions } from "../lib/server-config.js";
import { usageError, writeResult } from "../lib/output.js";
import { runPlatformLogin, runPlatformLogout } from "../lib/platform-auth.js";
import {
  platformOptionsOf,
  runPlatformOperation,
} from "../lib/platform-command.js";
import {
  resolvePlatformBaseUrl,
  resolvePlatformOrigin,
} from "../lib/platform-client.js";

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description(
      "Log in to MCPJam. Opens your browser for OAuth and stores the session locally."
    )
    .option("--no-browser", "Print the login URL instead of opening a browser")
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const platform = platformOptionsOf(command);
      if (platform.apiKey?.trim()) {
        throw usageError(
          "`mcpjam cloud login` uses browser OAuth. Pass --api-key to other cloud commands, or set MCPJAM_API_KEY."
        );
      }
      const apiUrl = resolvePlatformBaseUrl(platform);
      const origin = resolvePlatformOrigin(platform);

      const result = await runPlatformLogin(
        { origin, apiUrl },
        {
          ...(options.browser === false
            ? {
                openUrl: async (url: string) => {
                  process.stderr.write(
                    `Open this URL in your browser to continue:\n\n  ${url}\n\n`
                  );
                },
              }
            : {}),
        }
      );

      writeResult(
        {
          status: "logged_in",
          issuer: result.issuer,
          authFile: result.authFilePath,
          ...(result.expiresAt !== undefined
            ? { expiresAt: new Date(result.expiresAt).toISOString() }
            : {}),
        },
        globalOptions.format
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
        globalOptions.format
      );
    });

  program
    .command("whoami")
    .description("Show the MCPJam account behind the current credentials.")
    .action(async (_options, command) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformOperation(
        platformOptionsOf(command),
        globalOptions.timeout,
        async ({ client, credentialKind }) => {
          const me = await client.getMe();
          return {
            id: me.id,
            email: me.email,
            name: me.name,
            ...(me.plan ? { plan: me.plan } : {}),
            credential: credentialKind,
          };
        }
      );

      writeResult(result, globalOptions.format);
    });
}
