import { Command } from "commander";
import {
  getVerifiedServerSkill,
  isServerSkillRefusalError,
  listServerSkillCatalog,
  readVerifiedServerSkillFile,
} from "@mcpjam/sdk";
import { withEphemeralManager } from "../lib/ephemeral.js";
import { createCliRpcLogCollector } from "../lib/rpc-logs.js";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers.js";
import {
  addHostOption,
  addRetryOptions,
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parseRetryPolicy,
  parseServerConfig,
  resolveAliasedStringOption,
} from "../lib/server-config.js";
import { resolveHostFromOptions } from "../lib/host-resolve.js";
import { writeResult } from "../lib/output.js";

/**
 * `mcpjam skills` — inspect the Agent Skills a server SERVES (SEP-2640).
 *
 * Distinct from `mcpjam cloud skills`, which reads the Cloud Skills in your own
 * MCPJam project. Same word, opposite direction: this one asks somebody else's
 * server what it offers, and authors nothing.
 *
 * `mcpjam resources list` already shows `skill://` URIs as ordinary resources,
 * which proves the wire and shows nothing that makes a skill a skill: no
 * manifest, no digest or size verification, no identity check, and above all no
 * refusal reasons. THE REFUSALS ARE THE PRODUCT here — a server author asking
 * "why won't this load" needs to know which digest, which field, which uri, and
 * that is the entire delta over reading the resource.
 *
 * So a refusal prints as a RESULT on stdout with exit 0, matching the web and
 * v1 surfaces. Only a transport or usage failure is an error: refusing to load
 * an unverifiable skill is this command working, not failing.
 */
export function registerServerSkillsCommands(program: Command): void {
  const skills = program
    .command("skills")
    .description(
      "Inspect the Agent Skills an MCP server serves (SEP-2640). For your project's Cloud Skills, see `mcpjam cloud skills`.",
    );

  addHostOption(
    addRetryOptions(
      addSharedServerOptions(
        skills
          .command("list")
          .description(
            "List the skills a server serves, including ones it advertises that cannot be verified",
          ),
      ),
    ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
    const host = resolveHostFromOptions(options);
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const result = await withEphemeralManager(
      config,
      (manager, serverId) => listServerSkillCatalog(manager, serverId),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
        retryPolicy,
        host: host?.connection,
        skillsExtension: true,
      },
    );

    writeResult(
      withRpcLogsIfRequested(result, collector, globalOptions),
      globalOptions.format,
    );
  });

  addHostOption(
    addRetryOptions(
      addSharedServerOptions(
        skills
          .command("get")
          .description(
            "Fetch one skill by uri and verify it against its manifest, frontmatter and identity",
          )
          .option("--skill-uri <uri>", "Skill URI")
          .option("--uri <uri>", "Alias for --skill-uri"),
      ),
    ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
    const host = resolveHostFromOptions(options);
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const skillUri = resolveAliasedStringOption(
      options as Record<string, unknown>,
      [
        { key: "skillUri", flag: "--skill-uri" },
        { key: "uri", flag: "--uri" },
      ],
      "Skill URI",
      { required: true },
    ) as string;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => {
        try {
          return {
            skill: await getVerifiedServerSkill(manager, {
              serverId,
              uri: skillUri,
            }),
          };
        } catch (error) {
          if (isServerSkillRefusalError(error)) return { refusal: error.refusal };
          throw error;
        }
      },
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
        retryPolicy,
        host: host?.connection,
        skillsExtension: true,
      },
    );

    writeResult(
      withRpcLogsIfRequested(result, collector, globalOptions),
      globalOptions.format,
    );
  });

  addHostOption(
    addRetryOptions(
      addSharedServerOptions(
        skills
          .command("read")
          .description(
            "Read one of a skill's supporting files, verified against that skill's manifest",
          )
          .option("--skill-uri <uri>", "URI of the skill that owns the file")
          .option("--resource-uri <uri>", "URI of the supporting file")
          .option("--uri <uri>", "Alias for --resource-uri"),
      ),
    ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
    const host = resolveHostFromOptions(options);
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const skillUri = resolveAliasedStringOption(
      options as Record<string, unknown>,
      [{ key: "skillUri", flag: "--skill-uri" }],
      "Skill URI",
      { required: true },
    ) as string;
    const resourceUri = resolveAliasedStringOption(
      options as Record<string, unknown>,
      [
        { key: "resourceUri", flag: "--resource-uri" },
        { key: "uri", flag: "--uri" },
      ],
      "Resource URI",
      { required: true },
    ) as string;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => {
        try {
          // The entry is re-fetched rather than assembled from the caller's
          // flags: the manifest IS the read allowlist, so accepting one from
          // the command line would let the caller authorize its own read.
          const skill = await getVerifiedServerSkill(manager, {
            serverId,
            uri: skillUri,
          });
          return {
            file: await readVerifiedServerSkillFile(manager, {
              serverId,
              entry: { uri: skill.skillUri, resources: skill.resources },
              resourceUri,
            }),
          };
        } catch (error) {
          if (isServerSkillRefusalError(error)) return { refusal: error.refusal };
          throw error;
        }
      },
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
        retryPolicy,
        host: host?.connection,
        skillsExtension: true,
      },
    );

    writeResult(
      withRpcLogsIfRequested(result, collector, globalOptions),
      globalOptions.format,
    );
  });
}
