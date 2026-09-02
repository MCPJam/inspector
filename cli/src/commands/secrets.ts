import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  createSecretOperation,
  deleteSecretOperation,
  getSecretOperation,
  listSecretsOperation,
  updateSecretOperation,
} from "@mcpjam/sdk/platform";
import { usageError, writeResult } from "../lib/output.js";
import {
  platformOptionsOf,
  runPlatformOperation as runPlatformCommand,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { resolveCloudProjectArgs } from "../lib/cloud-scope.js";
import { getGlobalOptions } from "../lib/server-config.js";

/**
 * `mcpjam cloud secrets` — the project credentials a real workflow needs.
 *
 * A project secret is a named credential (`STRIPE_API_KEY`, `GH_TOKEN`, a
 * `psql` password) that an environment can grant to the runs launched from it.
 *
 * ## Write-only
 *
 * Nothing here prints a value, and nothing can: `list` and `show` return
 * metadata — name, delivery mode, host binding, sharing, when it was last
 * handed to a run. A secret is written and delivered; it is never read back.
 *
 * ## How the value gets in
 *
 * `set` and `update` take the value from a FILE, an ENVIRONMENT VARIABLE, or
 * STDIN. There is deliberately no positional argument for it: a credential
 * typed as an argv token is written to shell history, is visible in `ps` and
 * `/proc` to every process on the machine for the life of the command, and
 * lands in CI logs that echo their commands.
 *
 *   mcpjam cloud secrets set --name STRIPE_API_KEY --value-file ./key.txt
 *   mcpjam cloud secrets set --name STRIPE_API_KEY --value-env STRIPE_KEY
 *   pass show stripe | mcpjam cloud secrets set --name STRIPE_API_KEY --value -
 *
 * `--value <literal>` exists, because scripting occasionally needs it, and it
 * is documented as the scripting-only option with the history caveat attached
 * rather than being quietly available.
 *
 * ## Delivery mode is a required decision
 *
 *   --delivery brokered      the sandbox's egress proxy injects the value as a
 *                            request header, OUTSIDE the VM. The box never
 *                            holds it, so a prompt-injected agent has nothing
 *                            to exfiltrate. Prevents EXTRACTION, not USE — any
 *                            process in the box can call the bound host while
 *                            the policy is live — and works for HTTPS APIs
 *                            only. Needs --host / --header / --template.
 *   --delivery materialized  a real environment variable inside the box, which
 *                            is the only thing a CLI can read. EXTRACTABLE BY
 *                            DESIGN: `env` prints it.
 */

/** Where a secret's value may come from. Exactly one, and never argv by default. */
type ValueOptions = {
  value?: string;
  valueFile?: string;
  valueEnv?: string;
};

/**
 * Resolve the value from whichever source the caller named.
 *
 * `--value -` and `--value-file -` both read STDIN, so a pipeline reads
 * naturally either way. The trailing newline a shell adds is stripped ONLY for
 * stdin and file input, where it is an artifact of how the text was produced;
 * an explicit `--value` is taken verbatim, because there the caller typed
 * exactly what they meant.
 */
export function resolveSecretValue(
  options: ValueOptions,
  { required }: { required: boolean }
): string | undefined {
  const supplied = [
    options.value !== undefined ? "--value" : null,
    options.valueFile !== undefined ? "--value-file" : null,
    options.valueEnv !== undefined ? "--value-env" : null,
  ].filter((flag): flag is string => flag !== null);

  if (supplied.length > 1) {
    throw usageError(
      `Provide exactly one of --value, --value-file, or --value-env (got ${supplied.join(
        ", "
      )}).`
    );
  }
  if (supplied.length === 0) {
    if (!required) return undefined;
    throw usageError(
      "A value is required. Prefer --value-file <path>, --value-env <VAR>, or `--value -` to read stdin; --value <literal> works but is written to your shell history."
    );
  }

  if (options.valueEnv !== undefined) {
    const value = process.env[options.valueEnv];
    if (value === undefined || value === "") {
      throw usageError(
        `Environment variable "${options.valueEnv}" is not set (or is empty).`
      );
    }
    return value;
  }

  const readStdinOrFile = (path: string): string => {
    try {
      return path === "-"
        ? readFileSync(0, "utf8")
        : readFileSync(path, "utf8");
    } catch (error) {
      throw usageError(
        path === "-"
          ? "Failed to read the secret value from stdin."
          : `Failed to read the secret value from "${path}".`,
        { source: error instanceof Error ? error.message : String(error) }
      );
    }
  };

  // A FILE IS READ VERBATIM; ONLY STDIN LOSES ONE TRAILING NEWLINE.
  //
  // Stripping unconditionally was wrong, and wrong in the way the backend's own
  // `validateSecretValue` warns about: a PEM block's final LF is part of the
  // credential, so a `--value-file key.pem` that quietly dropped it stored a
  // DIFFERENT secret than the file holds, and the failure surfaces much later
  // as "the API key is wrong" with nothing to look at. The REST schema and
  // `--value-env` both preserve whitespace; a file should agree with them.
  //
  // Stdin keeps the strip because there the newline is almost always the
  // shell's rather than the credential's — `echo tok | mcpjam ...` is the
  // dominant idiom — and it is documented on the flags as such.
  const stripOneTrailingNewline = (text: string): string =>
    text.replace(/\r?\n$/, "");

  if (options.valueFile !== undefined) {
    const raw = readStdinOrFile(options.valueFile);
    const text = options.valueFile === "-" ? stripOneTrailingNewline(raw) : raw;
    if (text === "") throw usageError("The secret value is empty.");
    return text;
  }

  // `--value -` is the stdin spelling most people reach for first.
  if (options.value === "-") {
    const text = stripOneTrailingNewline(readStdinOrFile("-"));
    if (text === "") throw usageError("The secret value is empty.");
    return text;
  }
  if (options.value === "") throw usageError("The secret value is empty.");
  return options.value;
}

/** The broker triple, or nothing. Presence is checked against `--delivery`. */
function brokerFields(options: {
  host?: string[];
  header?: string;
  template?: string;
}): {
  brokerHosts?: string[];
  brokerHeader?: string;
  brokerTemplate?: string;
} {
  return {
    ...(options.host !== undefined && options.host.length > 0
      ? { brokerHosts: options.host }
      : {}),
    ...(options.header !== undefined ? { brokerHeader: options.header } : {}),
    ...(options.template !== undefined
      ? { brokerTemplate: options.template }
      : {}),
  };
}

/** Commander's repeatable-option collector for `--host`. */
function collectHost(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function registerSecretsCommands(program: Command): void {
  const secrets = program
    .command("secrets")
    .description(
      "Store and manage the project credentials a workflow needs (stripe, gh, psql). Write-only: no command prints a value."
    );

  secrets
    .command("list")
    .description(
      "List the project's secrets — metadata only. Shows the project-shared ones plus your own personal ones."
    )
    .option(
      "--project <id-or-name>",
      "Project name or ID (defaults to the most recently updated project)"
    )
    .action(
      async (options: PlatformOptions & { project?: string }, command) => {
        const globalOptions = getGlobalOptions(command);
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            listSecretsOperation.execute(
              { project: resolveCloudProjectArgs(options).project },
              { client, signal }
            )
        );
        writeResult(result, globalOptions.format);
      }
    );

  secrets
    .command("show")
    .description(
      "Show one secret's metadata: delivery mode, host binding, sharing, last delivery. Never its value."
    )
    .requiredOption("--secret <id>", "Secret ID, from `cloud secrets list`")
    .option("--project <id-or-name>", "Project name or ID")
    .action(
      async (
        options: PlatformOptions & { project?: string; secret: string },
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            getSecretOperation.execute(
              {
                project: resolveCloudProjectArgs(options).project,
                secret: options.secret,
              },
              { client, signal }
            )
        );
        writeResult(result, globalOptions.format);
      }
    );

  secrets
    .command("set")
    .description(
      "Create a secret. The value comes from --value-file, --value-env, or stdin — never a positional argument."
    )
    .requiredOption(
      "--name <NAME>",
      "Environment-variable name (STRIPE_API_KEY). Uppercase, digits, underscores; not starting with a digit. Immutable."
    )
    .requiredOption(
      "--delivery <mode>",
      "brokered (the proxy injects it outside the sandbox — extraction-proof, not use-proof, HTTPS only) or materialized (a real env var inside the box, which is what a CLI can read, and which `env` prints)"
    )
    .option(
      "--value-file <path>",
      "Read the value from a file, VERBATIM — a trailing newline is kept, because in a PEM block it is part of the credential. `-` reads stdin instead, which drops one trailing newline. Preferred."
    )
    .option("--value-env <VAR>", "Read the value from an environment variable.")
    .option(
      "--value <literal>",
      "The value inline, or `-` to read stdin. SCRIPTING ONLY: an inline literal is written to your shell history and is visible in `ps` while the command runs."
    )
    .option("--description <text>", "What this credential is for.")
    .option(
      "--host <hostname>",
      "Brokered only, repeatable: an exact hostname the header is injected on (api.stripe.com). No scheme, no port, no wildcard.",
      collectHost
    )
    .option(
      "--header <name>",
      "Brokered only: the header name, e.g. Authorization."
    )
    .option(
      "--template <value>",
      'Brokered only: the header value with {} where the secret goes, e.g. "Bearer {}".'
    )
    .option(
      "--sharing <scope>",
      "project (default; delivered to every member's sessions, admin-only) or user (personal; delivered only in sessions you start)"
    )
    .option(
      "--idempotency-key <key>",
      "Retry key. Pass one: a retried create without it fails as a name conflict with the row the first attempt already made."
    )
    .action(
      async (
        options: PlatformOptions &
          ValueOptions & {
            project?: string;
            name: string;
            delivery: string;
            description?: string;
            host?: string[];
            header?: string;
            template?: string;
            sharing?: string;
            idempotencyKey?: string;
          },
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        const value = resolveSecretValue(options, { required: true })!;
        // Validated through the operation's own schema, so the CLI and the API
        // reject the same inputs with the same messages rather than growing a
        // second, drifting copy of the rules.
        const input = createSecretOperation.inputSchema.safeParse({
          project: resolveCloudProjectArgs(options).project,
          name: options.name,
          value,
          ...(options.description !== undefined
            ? { description: options.description }
            : {}),
          delivery: options.delivery,
          ...brokerFields(options),
          ...(options.sharing !== undefined
            ? { sharing: options.sharing }
            : {}),
          ...(options.idempotencyKey !== undefined
            ? { idempotencyKey: options.idempotencyKey }
            : {}),
        });
        if (!input.success) {
          throw usageError(
            `Invalid input: ${input.error.issues
              .map(
                (issue) =>
                  `${issue.path.join(".") || "(root)"}: ${issue.message}`
              )
              .join("; ")}`
          );
        }
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            createSecretOperation.execute(input.data, { client, signal })
        );
        writeResult(result, globalOptions.format);
      }
    );

  secrets
    .command("update")
    .description(
      "Rotate a secret's value and/or change how it is delivered. A rotation reaches NEW RUNS ONLY — a session already running keeps the value it was given."
    )
    .requiredOption("--secret <id>", "Secret ID, from `cloud secrets list`")
    .option("--project <id-or-name>", "Project name or ID")
    .option(
      "--value-file <path>",
      "Read the new value from a file, VERBATIM — a trailing newline is kept. `-` reads stdin instead, which drops one trailing newline. Preferred."
    )
    .option(
      "--value-env <VAR>",
      "Read the new value from an environment variable."
    )
    .option(
      "--value <literal>",
      "The new value inline, or `-` to read stdin. SCRIPTING ONLY — see `secrets set`."
    )
    .option("--description <text>", "Replacement description.")
    .option(
      "--clear-description",
      "Remove the description entirely, leaving the secret with none."
    )
    .option(
      "--delivery <mode>",
      "brokered or materialized. Switching to brokered needs --host/--header/--template in the same call; switching to materialized clears them."
    )
    .option("--host <hostname>", "Brokered only, repeatable.", collectHost)
    .option("--header <name>", "Brokered only: the header name.")
    .option("--template <value>", 'Brokered only: e.g. "Bearer {}".')
    .action(
      async (
        options: PlatformOptions &
          ValueOptions & {
            project?: string;
            secret: string;
            description?: string;
            clearDescription?: boolean;
            delivery?: string;
            host?: string[];
            header?: string;
            template?: string;
          },
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        // The two flags say opposite things about the same field, and picking a
        // winner would silently discard half of what was asked for.
        if (options.description !== undefined && options.clearDescription) {
          throw usageError(
            "Provide either --description or --clear-description, not both."
          );
        }
        const value = resolveSecretValue(options, { required: false });
        const input = updateSecretOperation.inputSchema.safeParse({
          project: resolveCloudProjectArgs(options).project,
          secret: options.secret,
          ...(value !== undefined ? { value } : {}),
          // `--clear-description` is the flag spelling of the `null` the REST
          // route and the SDK client already accept. Distinct from
          // `--description ""`, which SETS an empty description.
          ...(options.clearDescription ? { description: null } : {}),
          ...(options.description !== undefined
            ? { description: options.description }
            : {}),
          ...(options.delivery !== undefined
            ? { delivery: options.delivery }
            : {}),
          ...brokerFields(options),
        });
        if (!input.success) {
          throw usageError(
            `Invalid input: ${input.error.issues
              .map(
                (issue) =>
                  `${issue.path.join(".") || "(root)"}: ${issue.message}`
              )
              .join("; ")}`
          );
        }
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            updateSecretOperation.execute(input.data, { client, signal })
        );
        writeResult(result, globalOptions.format);
      }
    );

  secrets
    .command("rm")
    .description(
      "Delete a secret. HARD: the row and the encrypted value both go, and MCPJam stops delivering it. Not blocked when an environment still selects it — deletion never waits on cleanup. This does NOT revoke the credential at the provider that issued it, and runs already in flight keep the value they were handed."
    )
    .requiredOption("--secret <id>", "Secret ID, from `cloud secrets list`")
    .option("--project <id-or-name>", "Project name or ID")
    .action(
      async (
        options: PlatformOptions & { project?: string; secret: string },
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            deleteSecretOperation.execute(
              {
                project: resolveCloudProjectArgs(options).project,
                secret: options.secret,
              },
              { client, signal }
            )
        );
        writeResult(result, globalOptions.format);
      }
    );
}
