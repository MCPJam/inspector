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
 *
 * Project-scoped commands resolve their project through the same precedence
 * as every `cloud projects` command — flag > MCPJAM_PROJECT > repo link >
 * automatic — via `bindOperation`'s ambient resolution or `runCloudOp`. All
 * commands announce the Cloud audience line: this group writes to a project,
 * and which project must never be a surprise.
 */
import type { Command } from "commander";
import {
  getProjectServerOperation,
  getRegistryDirectoryServerOperation,
  installRegistryDirectoryServerOperation,
  installRegistryServerOperation,
  listRegistryConnectionsOperation,
  listRegistryDirectorySourcesOperation,
  listRegistryServersOperation,
  searchRegistryDirectoryOperation,
  uninstallRegistryServerOperation,
  type PlatformRegistryInstallResult,
} from "@mcpjam/sdk/platform";
import {
  addPlatformOptions,
  addProjectOption,
  bindOperation,
  parseIntegerOption,
  platformOptionsOf,
  runCloudOp,
  runPlatformOperation,
  type PlatformOptions,
} from "../lib/platform-command.js";
import {
  formatRegistryDirectoryServerHuman,
  formatRegistryInstallHuman,
} from "../lib/registry-render.js";
import { getGlobalOptions } from "../lib/server-config.js";
import { usageError, writeResult } from "../lib/output.js";

type RegistryOptions = PlatformOptions & {
  project?: string;
};

/**
 * Convex document ids are exactly 32 lowercase alphanumerics (see the
 * fixture ids in the v1 route tests). Anything looser misroutes long
 * alphanumeric names like `microsoftsharepointserver` onto the id shelf.
 *
 * Note the shelves only diverge on the wire when `--source` is present —
 * without it, both serialize to the same GET and the server re-applies its
 * own heuristic — so this stays a routing hint, not a correctness gate.
 *
 * DELIBERATELY TIGHTER THAN THE SERVER, which is why this no longer claims to
 * be the same shape. `mcpjam-inspector/server/routes/v1/convex-id-param.ts`
 * accepts `{30,36}` because there it is a REJECTION gate: a false negative
 * answers 404, so a future Convex id-format change must not break every
 * caller. Here a false negative only picks the `name` query parameter instead
 * of the id one, and the server re-decides anyway — so the exact shape is free
 * and strictly better at the one job this copy has. Do not "align" them.
 */
export function looksLikeConvexId(value: string): boolean {
  return /^[a-z0-9]{32}$/.test(value);
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
    { announce: true, cloudScope: { kind: "account" } },
  );

  bindOperation(
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
    searchRegistryDirectoryOperation,
    (
      options: RegistryOptions & {
        source?: string;
        connectable?: boolean;
        rowType?: string;
        endpointKind?: string;
        cursor?: string;
        limit?: string;
      },
      q,
    ) => ({
      q,
      source: options.source ?? "all",
      connectableOnly: options.connectable,
      rowType: options.rowType,
      endpointKind: options.endpointKind,
      cursor: options.cursor,
      limit: parseIntegerOption(options.limit, "--limit"),
    }),
    { announce: true, cloudScope: { kind: "account" } },
  );

  // Inline rather than bindOperation: the id-or-name shelf choice depends on
  // the positional's shape AND `--source`, which is per-invocation input
  // routing, not flag mapping. Announce and scope match the bound siblings.
  addPlatformOptions(
    group
      .command("show")
      .description(
        "Show one directory row by name or catalog id. Prints the freshness pin for `registry install`.",
      )
      .argument("<id-or-name>", "Directory server name or catalogServerId")
      .option(
        "--source <id>",
        "Directory source id when looking up by name. Discover ids with `registry sources`.",
      ),
  ).action(
    async (
      idOrName: string,
      options: RegistryOptions & { source?: string },
      command: Command,
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformOperation(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) => {
          const input =
            options.source || !looksLikeConvexId(idOrName)
              ? { name: idOrName, source: options.source }
              : { catalogServerId: idOrName };
          return getRegistryDirectoryServerOperation.execute(input, {
            client,
            signal,
          });
        },
        { quiet: globalOptions.quiet, cloudScope: { kind: "account" } },
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
    { announce: true, ambientProject: true },
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
    { announce: true, ambientProject: true },
  );

  // Inline rather than bindOperation: one visible command dispatches to two
  // operations (`--card` picks the shelf), validates cross-shelf flags, and
  // renders follow-up commands. Project precedence and the audience line
  // still go through the shared `runCloudOp` path.
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
      // Each pin flag belongs to exactly one shelf. Silently dropping a
      // caller's explicit argument would answer a question they did not ask —
      // for the freshness pins it would also quietly disable the TOCTOU
      // protection the flag exists for.
      if (options.card) {
        for (const [flag, value] of [
          ["--endpoint-url", options.endpointUrl],
          ["--expected-content-hash", options.expectedContentHash],
        ] as const) {
          if (value !== undefined) {
            throw usageError(
              `${flag} applies to directory installs and would be ignored with --card. Drop ${flag}, or omit --card. Card installs pin freshness with --expected-updated-at.`,
            );
          }
        }
      } else if (options.expectedUpdatedAt !== undefined) {
        throw usageError(
          "--expected-updated-at applies to card installs and would be ignored without --card. Add --card, or pin a directory install with --expected-content-hash.",
        );
      }
      const globalOptions = getGlobalOptions(command);
      const merged = platformOptionsOf<RegistryOptions>(command);
      const outcome = await runCloudOp(
        command,
        merged,
        async (context, project) => {
          const installed = options.card
            ? await installRegistryServerOperation.execute(
                {
                  ...project,
                  registryServerId: id,
                  expectedUpdatedAt: parseIntegerOption(
                    options.expectedUpdatedAt,
                    "--expected-updated-at",
                  ),
                },
                context,
              )
            : await installRegistryDirectoryServerOperation.execute(
                {
                  ...project,
                  catalogServerId: id,
                  endpointUrl: options.endpointUrl,
                  expectedContentHash: options.expectedContentHash,
                },
                context,
              );
          // Human output prints a ready-to-run connect command. The endpoint
          // is on the server row the install just wrote; fetching it is
          // best-effort garnish, never a reason to fail a finished install.
          let endpointUrl = options.endpointUrl;
          if (!endpointUrl && globalOptions.format === "human") {
            try {
              const server = await getProjectServerOperation.execute(
                { ...project, serverId: installed.serverId },
                context,
              );
              endpointUrl = server.url ?? undefined;
            } catch {
              // Fall back to the placeholder command.
            }
          }
          return { installed, project: project.project, endpointUrl };
        },
      );
      writeFormatted(
        command,
        outcome.installed,
        (value: PlatformRegistryInstallResult) =>
          formatRegistryInstallHuman(value, {
            project: outcome.project,
            endpointUrl: outcome.endpointUrl,
          }),
      );
    },
  );

  bindOperation(
    addProjectOption(
      group
        .command("uninstall")
        .description(
          "Remove a curated/org card install. Directory uninstall is `cloud projects servers remove`.",
        )
        .argument("<registryServerId>", "Registry card id"),
    ),
    uninstallRegistryServerOperation,
    (options: RegistryOptions, registryServerId) => ({
      project: options.project,
      registryServerId: registryServerId!,
    }),
    { announce: true, ambientProject: true },
  );
}
