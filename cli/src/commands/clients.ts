/**
 * `mcpjam cloud clients …` — the CLI's view of a project's clients.
 *
 * Registered with `.alias("hosts")` (precedent: `organizations.alias("orgs")`),
 * and every command takes `--client` with `--host` accepted as a deprecated
 * spelling. Passing both is a usage error rather than a silent precedence rule,
 * matching `--repetitions` / `--iterations` in `eval.ts`.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  createClientOperation,
  deleteClientOperation,
  getClientOperation,
  listClientsOperation,
  updateClientOperation,
  setClientServersOperation,
  duplicateClientOperation,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import { HOST_TEMPLATES as SDK_HOST_TEMPLATES } from "@mcpjam/sdk/host-config/templates";
import { JsonInputContext } from "../lib/json-input.js";
import { usageError, writeResult } from "../lib/output.js";
import {
  platformOptionsOf,
  runPlatformOperation as runPlatformCommand,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { resolveCloudProjectArgs } from "../lib/cloud-scope.js";
import { getGlobalOptions } from "../lib/server-config.js";

/**
 * Built-in client templates surfaced by `clients templates`, derived from the
 * SDK registry (single source of truth) so this list can't drift from what
 * `create --template` actually accepts.
 */
const CLIENT_TEMPLATES: ReadonlyArray<{ id: string; label: string }> =
  SDK_HOST_TEMPLATES.map(({ id, label }) => ({ id, label }));

/** Options every client command shares. */
type ClientSelectorOptions = { client?: string; host?: string };

/**
 * The client selector, from `--client` or the deprecated `--host`.
 *
 * Both-at-once is a usage ERROR, not a precedence rule. A precedence rule is
 * invisible: a script that passes both because someone half-finished a
 * migration would keep running, silently ignoring one of two selectors that may
 * name different clients. Same call as `--repetitions` / `--iterations`.
 */
function selectorOf(options: ClientSelectorOptions): string {
  if (options.client !== undefined && options.host !== undefined) {
    throw usageError(
      "Use either --client or its deprecated --host alias, not both."
    );
  }
  const selector = options.client ?? options.host;
  if (selector === undefined) {
    throw usageError("--client <id-or-name> is required.");
  }
  return selector;
}

/** Attach `--client` and its deprecated `--host` alias to a command. */
function withClientSelector(command: Command): Command {
  return command
    .option("--client <id-or-name>", "Client name or ID")
    .option("--host <id-or-name>", "Deprecated alias for --client");
}

/** Read a JSON object from --file (literal path or `-` for stdin) / --json. */
function loadConfigObject(options: {
  file?: string;
  json?: string;
}): Record<string, unknown> | undefined {
  if (options.file !== undefined && options.json !== undefined) {
    throw usageError("Provide either --file or --json, not both.");
  }
  let base: unknown;
  if (options.file !== undefined) {
    let text: string;
    try {
      text =
        options.file === "-"
          ? readFileSync(0, "utf8")
          : readFileSync(options.file, "utf8");
    } catch (error) {
      throw usageError(`Failed to read --file "${options.file}".`, {
        source: error instanceof Error ? error.message : String(error),
      });
    }
    if (text.trim() === "") throw usageError("--file input is empty.");
    try {
      base = JSON.parse(text);
    } catch (error) {
      throw usageError("--file must contain valid JSON.", {
        source: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (options.json !== undefined) {
    base = new JsonInputContext().parseJsonInputRecord(options.json, "--json");
  } else {
    return undefined;
  }
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    throw usageError("Client config must be a JSON object.");
  }
  return base as Record<string, unknown>;
}

// ── `--set key=value` ────────────────────────────────────────────────────────
//
// The parse is FIELD-OWNED, never a generic "try JSON, fall back to string"
// guess. That guess is wrong in both directions and silently: a system prompt
// of `123` would become the number 123, a prompt of `{"a":1}` an object, and a
// `temperature=0.2x` typo a string the backend rejects with a validator message
// that names a type the user never chose to send. Each field below declares how
// its value is read, so a wrong value fails HERE, naming the field and what it
// accepts.

type FieldKind = "string" | "number" | "boolean" | "json";

/**
 * How each settable field parses, and whether `--unset` may target it.
 *
 * `unsettable` mirrors the API exactly: an optional field clears to absent, a
 * required one resets to its documented default, and `modelId` does neither —
 * there is no way to express "this client pins no model", so `--unset modelId`
 * fails locally rather than travelling to the server to be refused there.
 */
const SETTABLE_FIELDS: Readonly<
  Record<string, { kind: FieldKind; unsettable: boolean; note?: string }>
> = {
  modelId: {
    kind: "string",
    unsettable: false,
    note: "a client cannot be edited into one that pins no model",
  },
  // Required-resettable: --unset resets to the canonical default.
  systemPrompt: { kind: "string", unsettable: true },
  temperature: { kind: "number", unsettable: true },
  requireToolApproval: { kind: "boolean", unsettable: true },
  connectionDefaults: { kind: "json", unsettable: true },
  // Optional-clearable: --unset clears to absent.
  respectToolVisibility: { kind: "boolean", unsettable: true },
  progressiveToolDiscovery: { kind: "boolean", unsettable: true },
  harness: { kind: "string", unsettable: true },
  computer: { kind: "json", unsettable: true },
  builtInToolIds: { kind: "json", unsettable: true },
  skillSelection: { kind: "json", unsettable: true },
  modelVisibleMcpToolResults: { kind: "json", unsettable: true },
  mcpToolResultImageRendering: { kind: "json", unsettable: true },
  mcpProfile: { kind: "json", unsettable: true },
  hostCapabilitiesOverride: { kind: "json", unsettable: true },
  chatUiOverride: { kind: "json", unsettable: true },
};

const SETTABLE_FIELD_LIST = Object.keys(SETTABLE_FIELDS).join(", ");

function unknownFieldError(field: string): never {
  throw usageError(
    `Unknown client field "${field}". Settable fields: ${SETTABLE_FIELD_LIST}.`
  );
}

/** Parse one `key=value` pair against its field's declared kind. */
export function parseSetPair(pair: string): [string, unknown] {
  const separator = pair.indexOf("=");
  if (separator <= 0) {
    throw usageError(`--set expects key=value, got "${pair}".`);
  }
  const field = pair.slice(0, separator).trim();
  const raw = pair.slice(separator + 1);
  const spec = SETTABLE_FIELDS[field];
  if (!spec) unknownFieldError(field);

  switch (spec.kind) {
    case "string":
      // Verbatim, including a value that LOOKS like JSON. A system prompt is
      // free text and `--set systemPrompt='{"a":1}'` means that string.
      return [field, raw];
    case "number": {
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(value)) {
        throw usageError(`--set ${field} expects a number, got "${raw}".`);
      }
      return [field, value];
    }
    case "boolean":
      // Only the two literals. Accepting `1`/`yes`/`on` would mean quietly
      // deciding what an unlisted spelling meant, and `--set x=maybe` silently
      // becoming `false` is the worst version of that.
      if (raw === "true") return [field, true];
      if (raw === "false") return [field, false];
      throw usageError(`--set ${field} expects true or false, got "${raw}".`);
    case "json":
      try {
        return [field, JSON.parse(raw)];
      } catch (error) {
        throw usageError(
          `--set ${field} expects JSON (it is an object or a list), got "${raw}".`,
          { source: error instanceof Error ? error.message : String(error) }
        );
      }
  }
}

/**
 * Build the `set` block from repeated `--set` / `--unset` flags.
 *
 * A field named by both is a usage error for the same reason `--client` and
 * `--host` together are: the user has expressed two intentions and the CLI must
 * not pick one.
 */
export function buildSetBlock(
  setPairs: string[] | undefined,
  unsetFields: string[] | undefined
): Record<string, unknown> | undefined {
  const set: Record<string, unknown> = {};
  for (const pair of setPairs ?? []) {
    const [field, value] = parseSetPair(pair);
    set[field] = value;
  }
  for (const field of unsetFields ?? []) {
    const spec = SETTABLE_FIELDS[field];
    if (!spec) unknownFieldError(field);
    if (!spec.unsettable) {
      throw usageError(
        `--unset ${field} is not allowed: ${
          spec.note ?? "this field has no cleared state"
        }.`
      );
    }
    if (field in set) {
      throw usageError(
        `--set and --unset both name "${field}"; pass one of them.`
      );
    }
    // `null` is what the API reads as "reset or clear", per field.
    set[field] = null;
  }
  return Object.keys(set).length > 0 ? set : undefined;
}

export function registerClientsCommands(program: Command): void {
  const clients = program
    .command("clients")
    // Kept so `mcpjam cloud hosts …` in existing scripts keeps working. The
    // op-bindings map names `cloud clients …` — the canonical spelling — and
    // the drift test resolves it against this same Commander tree.
    .alias("hosts")
    .description(
      "List, create, and manage the clients in your hosted MCPJam projects"
    );

  clients
    .command("templates")
    .description(
      "List the built-in templates usable with `clients create --template`"
    )
    .action((_options, command) => {
      const globalOptions = getGlobalOptions(command);
      writeResult({ items: CLIENT_TEMPLATES }, globalOptions.format);
    });

  clients
    .command("list")
    .description("List the clients saved in a project")
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
            listClientsOperation.execute(
              { project: resolveCloudProjectArgs(options).project },
              { client, signal }
            )
        );
        writeResult(result, globalOptions.format);
      }
    );

  withClientSelector(
    clients
      .command("get")
      .description(
        "Show one client's full settings, its configId (the token every edit takes), and what a config edit would affect"
      )
  )
    .option("--project <id-or-name>", "Project name or ID")
    .action(
      async (
        options: PlatformOptions & { project?: string } & ClientSelectorOptions,
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            getClientOperation.execute(
              {
                project: resolveCloudProjectArgs(options).project,
                client: selectorOf(options),
              },
              { client, signal }
            )
        );
        writeResult(result, globalOptions.format);
      }
    );

  clients
    .command("create")
    .description(
      "Create a client from a built-in template (--template) or a full config (--file/--json)"
    )
    .requiredOption("--name <name>", "Display name for the new client")
    .option("--project <id-or-name>", "Project name or ID")
    .option(
      "--template <id>",
      "Built-in template id (see `clients templates`), e.g. claude, chatgpt, cursor"
    )
    .option(
      "--theme <theme>",
      "Theme for the seeded config: light or dark (template only)"
    )
    .option("--file <path>", "Client config v2 JSON file (or - for stdin)")
    .option("--json <json>", "Inline client config v2 JSON (or @file, or -)")
    .action(
      async (
        options: PlatformOptions & {
          project?: string;
          name: string;
          template?: string;
          theme?: string;
          file?: string;
          json?: string;
        },
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        const config = loadConfigObject(options);
        const input = validateInput(createClientOperation, {
          project: resolveCloudProjectArgs(options).project,
          name: options.name,
          ...(options.template !== undefined
            ? { template: options.template }
            : {}),
          ...(options.theme !== undefined ? { theme: options.theme } : {}),
          ...(config !== undefined ? { config } : {}),
        });
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            createClientOperation.execute(input, { client, signal })
        );
        writeResult(result, globalOptions.format);
      }
    );

  withClientSelector(
    clients
      .command("update")
      .description(
        "Edit a client's name and/or its config. Use --set/--unset for named fields, or --file/--json to replace the whole config"
      )
  )
    .option("--project <id-or-name>", "Project name or ID")
    .option("--name <name>", "New display name")
    .option(
      "--expected-name <name>",
      "The name you last read (required with --name)"
    )
    .option(
      "--expected-config-id <id>",
      "The configId you last read (required for any config edit)"
    )
    .option(
      "--set <key=value...>",
      `Set one field. Repeatable. Fields: ${SETTABLE_FIELD_LIST}`
    )
    .option(
      "--unset <key...>",
      "Clear an optional field to absent, or reset a required one to its default. Repeatable"
    )
    .option(
      "--file <path>",
      "Replacement client config v2 JSON (or - for stdin)"
    )
    .option(
      "--json <json>",
      "Inline replacement client config v2 JSON (or @file, or -)"
    )
    .action(
      async (
        options: PlatformOptions &
          ClientSelectorOptions & {
            project?: string;
            name?: string;
            expectedName?: string;
            expectedConfigId?: string;
            set?: string[];
            unset?: string[];
            file?: string;
            json?: string;
          },
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        const config = loadConfigObject(options);
        const set = buildSetBlock(options.set, options.unset);
        if (config !== undefined && set !== undefined) {
          throw usageError(
            "Use either --set/--unset (named fields) or --file/--json (whole-config replacement), not both."
          );
        }
        const input = validateInput(updateClientOperation, {
          project: resolveCloudProjectArgs(options).project,
          client: selectorOf(options),
          ...(options.name !== undefined ? { name: options.name } : {}),
          ...(options.expectedName !== undefined
            ? { expectedName: options.expectedName }
            : {}),
          ...(options.expectedConfigId !== undefined
            ? { expectedConfigId: options.expectedConfigId }
            : {}),
          ...(config !== undefined ? { config } : {}),
          ...(set !== undefined ? { set } : {}),
        });
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            updateClientOperation.execute(input, { client, signal })
        );
        writeResult(result, globalOptions.format);
      }
    );

  withClientSelector(
    clients
      .command("delete")
      .description("Permanently delete a client from a project")
  )
    .option("--project <id-or-name>", "Project name or ID")
    .action(
      async (
        options: PlatformOptions & { project?: string } & ClientSelectorOptions,
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            deleteClientOperation.execute(
              {
                project: resolveCloudProjectArgs(options).project,
                client: selectorOf(options),
              },
              { client, signal }
            )
        );
        writeResult(result, globalOptions.format);
      }
    );

  withClientSelector(
    clients
      .command("servers")
      .description(
        "Replace a client's required and optional server attachments (servers you omit are detached)"
      )
  )
    .requiredOption(
      "--server-ids <id,...>",
      "Comma-separated required server IDs"
    )
    .option(
      "--optional-server-ids <id,...>",
      "Comma-separated optional server IDs"
    )
    .requiredOption(
      "--expected-config-id <id>",
      "The configId you last read for this client"
    )
    .option("--project <id-or-name>", "Project name or ID")
    .action(
      async (
        options: PlatformOptions &
          ClientSelectorOptions & {
            project?: string;
            serverIds: string;
            optionalServerIds?: string;
            expectedConfigId: string;
          },
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        const splitIds = (value: string) =>
          value
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
        const input = validateInput(setClientServersOperation, {
          project: resolveCloudProjectArgs(options).project,
          client: selectorOf(options),
          serverIds: splitIds(options.serverIds),
          expectedConfigId: options.expectedConfigId,
          ...(options.optionalServerIds
            ? { optionalServerIds: splitIds(options.optionalServerIds) }
            : {}),
        });
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            setClientServersOperation.execute(input, { client, signal })
        );
        writeResult(result, globalOptions.format);
      }
    );

  withClientSelector(
    clients
      .command("duplicate")
      .description("Duplicate a client's current config into a new client")
  )
    .option("--name <name>", "Name for the new client")
    .option("--project <id-or-name>", "Project name or ID")
    .action(
      async (
        options: PlatformOptions &
          ClientSelectorOptions & { project?: string; name?: string },
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        const input = validateInput(duplicateClientOperation, {
          project: resolveCloudProjectArgs(options).project,
          client: selectorOf(options),
          ...(options.name === undefined ? {} : { name: options.name }),
        });
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            duplicateClientOperation.execute(input, { client, signal })
        );
        writeResult(result, globalOptions.format);
      }
    );
}

/** Validate a merged input object against an operation's schema (usage error on failure). */
function validateInput<TInput>(
  op: PlatformOperation<TInput, unknown>,
  raw: unknown
): TInput {
  const parsed = op.inputSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw usageError(`Invalid input: ${detail}`);
  }
  return parsed.data;
}
