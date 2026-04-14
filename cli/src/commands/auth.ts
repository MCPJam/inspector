import {
  AuthError,
  BackendClient,
  DEFAULT_BACKEND_BASE_URL,
  getCredentials,
  loginWithBrowser,
  logout,
  resolveConfigPath,
  type UserInfo,
} from "@mcpjam/sdk/auth";
import { Command } from "commander";
import open from "open";
import { version as pkgVersion } from "../../package.json";
import {
  cliError,
  operationalError,
  setProcessExitCode,
  usageError,
  writeResult,
} from "../lib/output";
import { getGlobalOptions } from "../lib/server-config";

const DEFAULT_WEB_BASE_URL = "https://app.mcpjam.com";

function resolveWebBaseUrl(cli: string | undefined): string {
  return cli ?? process.env.MCPJAM_WEB_URL ?? DEFAULT_WEB_BASE_URL;
}

function resolveApiBaseUrl(cli: string | undefined): string {
  return cli ?? process.env.MCPJAM_API_URL ?? DEFAULT_BACKEND_BASE_URL;
}

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description(
      "Authenticate this machine with MCPJam. Opens a browser to mint a workspace API key and writes it to ~/.mcpjam/config.json.",
    )
    .option(
      "--profile <name>",
      "Profile name to store credentials under",
      "default",
    )
    .option(
      "--web-url <url>",
      "MCPJam web app base URL (for the /cli-auth handshake)",
    )
    .option(
      "--api-url <url>",
      "MCPJam backend (Convex HTTP) base URL used for whoami verification",
    )
    .option(
      "--no-browser",
      "Do not spawn a browser; print the URL and fall back to a paste-key flow",
    )
    .option(
      "--timeout <seconds>",
      "Override the default 5-minute wait for the browser callback",
      (value) => {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw usageError(`Invalid --timeout "${value}". Must be a positive integer (seconds).`);
        }
        return parsed;
      },
    )
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const webBaseUrl = resolveWebBaseUrl(options.webUrl as string | undefined);
      const apiBaseUrl = resolveApiBaseUrl(options.apiUrl as string | undefined);
      const useBrowser = options.browser !== false;
      const timeoutMs = options.timeout
        ? Number(options.timeout) * 1000
        : undefined;

      try {
        const result = await loginWithBrowser({
          webBaseUrl,
          apiBaseUrl,
          profile: options.profile as string,
          clientVersion: pkgVersion,
          timeoutMs,
          displayMode: useBrowser ? "browser" : "code",
          openUrl: useBrowser
            ? async (url) => {
                await open(url);
              }
            : undefined,
          onPrompt: ({ url }) => {
            if (globalOptions.format === "human") {
              if (useBrowser) {
                process.stderr.write(
                  `\nOpening browser to complete login:\n  ${url}\n\n` +
                    "Waiting for the callback... (Ctrl+C to cancel)\n",
                );
              } else {
                process.stderr.write(
                  `\nOpen this URL in a browser to complete login:\n  ${url}\n\n`,
                );
              }
            }
          },
        });

        // Verify immediately so we report a real email, not what the web
        // app claimed. Failure here means the backend rejected the freshly
        // minted key — surface it rather than silently succeeding.
        let user: UserInfo = result.credentials.kind === "apiKey"
          ? result.credentials.user
          : {
              userId: "",
              email: "",
              name: "",
              workspaceId: null,
              workspaceName: null,
            };
        try {
          const client = new BackendClient({
            baseUrl: apiBaseUrl,
            credentials: result.credentials,
          });
          user = await client.whoami();
        } catch (err) {
          // Non-fatal: the key is already persisted. Warn and continue.
          process.stderr.write(
            `Warning: could not verify credentials against ${apiBaseUrl}. ` +
              `The key is saved but whoami() failed: ${
                err instanceof Error ? err.message : String(err)
              }\n`,
          );
        }

        const payload = {
          profile: result.profile,
          configPath: resolveConfigPath(),
          user,
        };

        if (globalOptions.format === "human") {
          process.stdout.write(
            `\n✓ Logged in as ${user.email || "<unknown>"}${
              user.workspaceName ? ` (workspace: ${user.workspaceName})` : ""
            }\n` +
              `  Profile: ${payload.profile}\n` +
              `  Credentials: ${payload.configPath}\n`,
          );
        } else {
          writeResult(payload, globalOptions.format);
        }
      } catch (err) {
        throw mapAuthError(err);
      }
    });

  program
    .command("logout")
    .description("Remove stored MCPJam credentials from this machine.")
    .option(
      "--profile <name>",
      "Profile name to remove (defaults to the active profile)",
    )
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const removed = await logout({
        profile: options.profile as string | undefined,
      });
      const payload = {
        removed,
        profile: options.profile ?? "<default>",
        configPath: resolveConfigPath(),
      };
      if (globalOptions.format === "human") {
        if (removed) {
          process.stdout.write(
            `✓ Removed profile ${payload.profile} from ${payload.configPath}.\n`,
          );
        } else {
          process.stdout.write(
            `No credentials found for profile ${payload.profile}.\n`,
          );
          setProcessExitCode(1);
        }
      } else {
        writeResult(payload, globalOptions.format);
        if (!removed) setProcessExitCode(1);
      }
    });

  program
    .command("whoami")
    .description(
      "Print the user and workspace associated with stored credentials.",
    )
    .option(
      "--profile <name>",
      "Profile to read (defaults to the active profile)",
    )
    .option(
      "--api-url <url>",
      "MCPJam backend (Convex HTTP) base URL used for verification",
    )
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const apiBaseUrl = resolveApiBaseUrl(options.apiUrl as string | undefined);
      const resolved = await getCredentials({
        profile: options.profile as string | undefined,
      });
      if (!resolved) {
        if (globalOptions.format === "human") {
          process.stderr.write(
            "Not logged in. Run `mcpjam login` or set MCPJAM_API_KEY.\n",
          );
        } else {
          writeResult({ authenticated: false }, globalOptions.format);
        }
        setProcessExitCode(1);
        return;
      }

      try {
        const client = new BackendClient({
          baseUrl: apiBaseUrl,
          credentials: resolved.credentials,
        });
        const user = await client.whoami();
        const payload = {
          authenticated: true,
          source: resolved.source,
          user,
        };
        if (globalOptions.format === "human") {
          process.stdout.write(
            `${user.email || "<unknown>"}${
              user.workspaceName ? `  (workspace: ${user.workspaceName})` : ""
            }\n`,
          );
        } else {
          writeResult(payload, globalOptions.format);
        }
      } catch (err) {
        throw mapAuthError(err);
      }
    });
}

function mapAuthError(err: unknown): unknown {
  if (err instanceof AuthError) {
    const exitCode = err.code === "TIMEOUT" ? 124 : 1;
    return cliError(err.code, err.message, exitCode, err.details);
  }
  return err;
}

// Keep `operationalError` imported so future error paths that don't come from
// `AuthError` can still use the helper without re-importing.
void operationalError;
