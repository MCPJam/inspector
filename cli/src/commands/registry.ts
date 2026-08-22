/**
 * `mcpjam registry` — search the scraped MCP directories and the curated
 * cards, then install into a Cloud project.
 *
 * ALWAYS a Cloud project write. There is no local server store; ad-hoc local
 * use is `mcpjam server probe --url …` (printed by `registry show` when a
 * remoteUrl is known). Directory uninstall is `cloud projects servers remove`
 * — this group only uninstalls cards.
 *
 * `registry install` is one verb, two shelves: default = directory,
 * `--card` = curated/org card. Both ids are opaque Convex ids; the flag is
 * the disambiguator.
 */
import type { Command } from "commander";
import {
  getRegistryDirectoryServerOperation,
  installRegistryDirectoryServerOperation,
  installRegistryServerOperation,
  listRegistryConnectionsOperation,
  listRegistryDirectorySourcesOperation,
  listRegistryServersOperation,
  searchRegistryDirectoryOperation,
  uninstallRegistryServerOperation,
  type PlatformCatalogServer,
  type PlatformRegistryInstallResult,
} from "@mcpjam/sdk/platform";
import {
  addPlatformOptions,
  addProjectOption,
  bindOperation,
  parseIntegerOption,
  platformOptionsOf,
  runPlatformOperation,
  type PlatformOptions,
} from "../lib/platform-command.js";
import {
  formatRegistryDirectoryServerHuman,
  formatRegistryInstallHuman,
} from "../lib/registry-render.js";
import { getGlobalOptions } from "../lib/server-config.js";
import { writeResult } from "../lib/output.js";

type RegistryOptions = PlatformOptions & {
  project?: string;
};

function looksLikeConvexId(value: string): boolean {
  return /^[a-z0-9]{20,}$/i.test(value);
}

function writeFormatted<T>(
  command: Command,
  value: T,
  human: (value: T) => string,
): void {
  const format = getGlobalOptions(command).format;
  if (format === "human") {
    process.stdout.write(`${human(value)}\n`);
    return;
  }
  writeResult(value, format);
}

export function registerRegistryCommands(program: Command): void {
  const group = program
    .command("registry")
    .description(
      "Search MCP directories and curated cards, then install into a Cloud project",
    );

  bindOperation(
    group
      .command("sources")
      .description(
        "List directory source ids. Sources are data, not an enum — pass one to `registry search --source`.",
      ),
    listRegistryDirectorySourcesOperation,
    () => ({}),
  );

  addPlatformOptions(
    group
      .command("search")
    .description(
      "Search scraped MCP directories. Prefer a matching curated card from `registry servers --scope global` when one exists.",
    )
    .argument("[q]", "Search query")
    .option(
      "--source <id>",
      "Directory source id, or `all` (default). Discover ids with `registry sources`.",
    )
    .option("--connectable", "Only rows that can be installed")
    .option("--row-type <type>", "Filter by row type")
    .option("--endpoint-kind <kind>", "Filter by endpoint kind")
    .option("--cursor <cursor>", "Page cursor from a previous response")
    .option("--limit <n>", "Page size"),
  ).action(
      async (
        q: string | undefined,
        options: RegistryOptions & {
          source?: string;
          connectable?: boolean;
          rowType?: string;
          endpointKind?: string;
          cursor?: string;
          limit?: string;
        },
        command: Command,
      ) => {
        const globalOptions = getGlobalOptions(command);
        const result = await runPlatformOperation(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            searchRegistryDirectoryOperation.execute(
              {
                q,
                source: options.source ?? "all",
                connectableOnly: options.connectable,
                rowType: options.rowType,
                endpointKind: options.endpointKind,
                cursor: options.cursor,
                limit: parseIntegerOption(options.limit, "--limit"),
              },
              { client, signal },
            ),
        );
        writeResult(result, globalOptions.format);
      },
    );

  addPlatformOptions(
    group
      .command("show")
    .description(
      "Show one directory row by name or catalog id. Prints the freshness pin for `registry install`.",
    )
    .argument("<name-or-id>", "Directory server name or catalogServerId")
    .option(
      "--source <id>",
      "Directory source id when looking up by name. Discover ids with `registry sources`.",
    ),
  ).action(
      async (
        nameOrId: string,
        options: RegistryOptions & { source?: string },
        command: Command,
      ) => {
        const globalOptions = getGlobalOptions(command);
        const result = await runPlatformOperation(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) => {
            const input =
              options.source || !looksLikeConvexId(nameOrId)
                ? { name: nameOrId, source: options.source }
                : { catalogServerId: nameOrId };
            return getRegistryDirectoryServerOperation.execute(input, {
              client,
              signal,
            });
          },
        );
        writeFormatted(command, result, formatRegistryDirectoryServerHuman);
      },
    );

  bindOperation(
    addProjectOption(
      group
        .command("servers")
        .description(
          "List curated global cards and the project's organization registry cards",
        )
        .option(
          "--scope <scope>",
          "global | organization | all (default all)",
        ),
    ),
    listRegistryServersOperation,
    (
      options: RegistryOptions & {
        scope?: "global" | "organization" | "all";
      },
    ) => ({
      project: options.project,
      scope: options.scope,
    }),
  );

  bindOperation(
    addProjectOption(
      group
        .command("connections")
        .description(
          "List directory and card installs already in a Cloud project",
        ),
    ),
    listRegistryConnectionsOperation,
    (options: RegistryOptions) => ({ project: options.project }),
  );

  addProjectOption(
    addPlatformOptions(
    group
      .command("install")
      .description(
        "Install a directory row into a Cloud project. Pass --card to install a curated/org card instead. This is not a live connection.",
      )
      .argument("<id>", "catalogServerId, or registryServerId with --card")
      .option(
        "--card",
        "Install a curated/org registry card instead of a directory row",
      )
      .option(
        "--endpoint-url <url>",
        "Override the directory endpoint (required for tenant/options kinds)",
      )
      .option(
        "--expected-content-hash <hash>",
        "Freshness pin from `registry show` (directory installs)",
      )
      .option(
        "--expected-updated-at <ms>",
        "Freshness pin from `registry servers` (card installs)",
      ),
    ),
  ).action(
    async (
      id: string,
      options: RegistryOptions & {
        card?: boolean;
        endpointUrl?: string;
        expectedContentHash?: string;
        expectedUpdatedAt?: string;
      },
      command: Command,
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformOperation(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) => {
          if (options.card) {
            return installRegistryServerOperation.execute(
              {
                project: options.project,
                registryServerId: id,
                expectedUpdatedAt: parseIntegerOption(
                  options.expectedUpdatedAt,
                  "--expected-updated-at",
                ),
              },
              { client, signal },
            );
          }
          return installRegistryDirectoryServerOperation.execute(
            {
              project: options.project,
              catalogServerId: id,
              endpointUrl: options.endpointUrl,
              expectedContentHash: options.expectedContentHash,
            },
            { client, signal },
          );
        },
      );
      writeFormatted(command, result, formatRegistryInstallHuman);
    },
  );

  addProjectOption(
    addPlatformOptions(
      group
        .command("uninstall")
        .description(
          "Remove a curated/org card install. Directory uninstall is `cloud projects servers remove`.",
        )
        .argument("<registryServerId>", "Registry card id"),
    ),
  ).action(
    async (
      registryServerId: string,
      options: RegistryOptions,
      command: Command,
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformOperation(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          uninstallRegistryServerOperation.execute(
            { project: options.project, registryServerId },
            { client, signal },
          ),
      );
      writeResult(result, globalOptions.format);
    },
  );
}
