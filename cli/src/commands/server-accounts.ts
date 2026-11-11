/**
 * `mcpjam cloud server-accounts`: the accounts a saved server signs in with
 * for hosted runs, addressed by id or by name.
 *
 * Tokens are write-only: `set` stores one, and no command prints one. `set`
 * reads the access token from a file, an environment variable or stdin, and
 * refuses one typed on the command line, where shell history keeps it, `ps`
 * shows it while the command runs, and CI logs that echo commands record it.
 * Unlike `secrets set` there is no literal escape hatch: CI that uploads a
 * fresh token before each run already holds it in a file or a variable.
 *
 *   mcpjam cloud server-accounts set --server my-server \
 *     --account test-automation-1 --client-id my-client \
 *     --access-token-env MCP_ACCESS_TOKEN
 *   ./sign-in | mcpjam cloud server-accounts set ... --access-token -
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  deleteServerAccountOperation,
  getServerAccountOperation,
  listServerAccountsOperation,
  updateServerAccountOperation,
  uploadServerAccountTokensOperation,
  type UploadServerAccountTokensInput,
} from "@mcpjam/sdk/platform";
import { usageError } from "../lib/output.js";
import {
  addProjectOption,
  bindOperation,
  parseIntegerOption,
  type PlatformOptions,
} from "../lib/platform-command.js";

type ServerOptions = PlatformOptions & { project?: string; server: string };
type AccountOptions = ServerOptions & { account: string };

type TokenOptions = {
  accessToken?: string;
  accessTokenFile?: string;
  accessTokenEnv?: string;
  refreshTokenFile?: string;
};

type SetOptions = AccountOptions &
  TokenOptions & { clientId: string; expiresIn?: string };

/**
 * A token has no whitespace, so whitespace around one is the editor's or the
 * shell's. Sent as is, a trailing newline would end up in the Authorization
 * header of every run that uses the account.
 */
function nonEmptyToken(text: string, what: string): string {
  const token = text.trim();
  if (token === "") {
    throw usageError(
      `The ${what} is empty. Check the file, variable or pipe it comes from.`,
    );
  }
  return token;
}

/** A token from a file, or from stdin for `-`. */
function readTokenFrom(path: string, what: string): string {
  let text: string;
  try {
    text = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  } catch (error) {
    throw usageError(
      path === "-"
        ? `Could not read the ${what} from stdin. Pipe it in, or read it from a file.`
        : `Could not read the ${what} from "${path}". Check the path and that you can read the file.`,
      { source: error instanceof Error ? error.message : String(error) },
    );
  }
  return nonEmptyToken(text, what);
}

/** Exactly one source, and never a literal: see the module comment. */
function readAccessToken(options: TokenOptions): string {
  if (options.accessToken !== undefined && options.accessToken !== "-") {
    throw usageError(
      "Nothing was uploaded: a token typed on the command line is kept in shell history and visible to other processes. Pass it with --access-token-file <path> or --access-token-env <VAR>, or pipe it to --access-token -.",
    );
  }
  const given = [
    options.accessTokenFile !== undefined ? "--access-token-file" : null,
    options.accessTokenEnv !== undefined ? "--access-token-env" : null,
    options.accessToken !== undefined ? "--access-token" : null,
  ].filter((flag): flag is string => flag !== null);
  if (given.length !== 1) {
    throw usageError(
      given.length === 0
        ? "An access token is required. Pass --access-token-file <path> or --access-token-env <VAR>, or pipe it to --access-token -."
        : `Pass only one of ${given.join(" or ")}.`,
    );
  }
  if (options.accessTokenEnv !== undefined) {
    const value = process.env[options.accessTokenEnv];
    if (value === undefined) {
      throw usageError(
        `Environment variable "${options.accessTokenEnv}" is not set. Set it to the access token, or pass --access-token-file <path>.`,
      );
    }
    return nonEmptyToken(value, `access token in "${options.accessTokenEnv}"`);
  }
  return readTokenFrom(options.accessTokenFile ?? "-", "access token");
}

/** Flags are checked before stdin is read, so a refusal never consumes it. */
function buildUploadInput(options: SetOptions): UploadServerAccountTokensInput {
  if (options.accessToken === "-" && options.refreshTokenFile === "-") {
    throw usageError(
      "Only one token can come from stdin. Read the refresh token from a file with --refresh-token-file <path>.",
    );
  }
  const expiresIn = parseIntegerOption(options.expiresIn, "--expires-in", {
    min: 1,
  });
  const accessToken = readAccessToken(options);
  const refreshToken =
    options.refreshTokenFile === undefined
      ? undefined
      : readTokenFrom(options.refreshTokenFile, "refresh token");
  // The operation's own schema, so the CLI refuses what the API refuses.
  const parsed = uploadServerAccountTokensOperation.inputSchema.safeParse({
    project: options.project,
    server: options.server,
    account: options.account,
    tokens: {
      access_token: accessToken,
      ...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}),
      ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
    },
    clientInformation: { clientId: options.clientId },
  });
  if (!parsed.success) {
    throw usageError(
      `Invalid input: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function accountInput(options: AccountOptions) {
  return {
    project: options.project,
    server: options.server,
    account: options.account,
  };
}

function serverCommand(
  accounts: Command,
  name: string,
  description: string,
): Command {
  return addProjectOption(
    accounts
      .command(name)
      .description(description)
      .requiredOption("--server <id-or-name>", "Server ID or name"),
  );
}

function accountCommand(
  accounts: Command,
  name: string,
  description: string,
): Command {
  return serverCommand(accounts, name, description).requiredOption(
    "--account <id-or-name>",
    "Account ID or name",
  );
}

export function registerServerAccountsCommands(cloud: Command): void {
  const accounts = cloud
    .command("server-accounts")
    .description(
      "Manage the accounts a saved server signs in with for hosted runs. Write-only: no command prints a token.",
    );

  bindOperation(
    serverCommand(
      accounts,
      "list",
      "List a saved server's accounts: id, name, whether runs use it by default, whether it needs reconnecting, and whether it is for hosted runs only",
    ),
    listServerAccountsOperation,
    (options: ServerOptions) => ({
      project: options.project,
      server: options.server,
    }),
  );

  bindOperation(
    accountCommand(
      accounts,
      "show",
      "Show one of a saved server's accounts, by ID or name. Never its token",
    ),
    getServerAccountOperation,
    accountInput,
  );

  bindOperation(
    accountCommand(
      accounts,
      "set",
      "Upload an access token to an account. A name no account has creates the account; otherwise its token is replaced and its ID stays. Accounts uploaded this way are for hosted runs only",
    )
      .requiredOption(
        "--client-id <id>",
        "The OAuth client the token was issued to",
      )
      .option("--access-token-file <path>", "Read the access token from a file")
      .option(
        "--access-token-env <VAR>",
        "Read the access token from an environment variable",
      )
      .option(
        "--access-token <->",
        "`-` reads the access token from stdin. A token typed here is refused",
      )
      .option(
        "--refresh-token-file <path>",
        "Read a refresh token from a file, or `-` for stdin. Leave it out when you upload a fresh token before each run, or when the issuer rejects refreshes: stored, it only adds a long-lived credential",
      )
      .option(
        "--expires-in <seconds>",
        "Seconds until the access token expires",
      ),
    uploadServerAccountTokensOperation,
    buildUploadInput,
  );

  bindOperation(
    accountCommand(accounts, "rename", "Rename an account").requiredOption(
      "--name <name>",
      "The new name: letters, digits, '.', '_' and '-', starting with a letter or digit, at most 64 characters",
    ),
    updateServerAccountOperation,
    (options: AccountOptions & { name: string }) => ({
      ...accountInput(options),
      name: options.name,
    }),
  );

  bindOperation(
    accountCommand(
      accounts,
      "default",
      "Make an account the default. Runs with no saved account choice sign in as the default, so set it before you start a run",
    ),
    updateServerAccountOperation,
    (options: AccountOptions) => ({
      ...accountInput(options),
      isDefault: true as const,
    }),
  );

  bindOperation(
    accountCommand(
      accounts,
      "delete",
      "Delete an account and its stored token, and ask the token's issuer to revoke it where it supports that. The default account can't be deleted while other accounts exist: make another account the default first",
    ),
    deleteServerAccountOperation,
    accountInput,
  );
}
