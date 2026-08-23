import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  archiveEnvironmentOperation,
  createEnvironmentOperation,
  ensureAdhocEnvironmentOperation,
  nameEnvironmentOperation,
  getEnvironmentCapabilitiesOperation,
  getEnvironmentOperation,
  listEnvironmentsOperation,
  resolveEnvironmentOperation,
  restoreEnvironmentOperation,
  updateEnvironmentOperation,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import { JsonInputContext } from "../lib/json-input.js";
import { usageError, writeResult } from "../lib/output.js";
import {
  platformOptionsOf,
  runCloudOp,
  runPlatformOperation as runPlatformCommand,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { resolveCloudProjectArgs } from "../lib/cloud-scope.js";
import { getGlobalOptions } from "../lib/server-config.js";

/**
 * `mcpjam cloud environments` — the Project Environment surface.
 *
 * A project environment is a named execution bundle (one host, optionally a
 * standalone server group, pinned skills, and pinned plugin versions) that eval
 * suites and journeys run against. It is NOT a Computer sandbox image — those
 * are `mcpjam cloud images`.
 *
 * Environments are revisioned: `update`, `archive`, and `restore` all require
 * `--expected-revision`, the revision you last read with `get`. If someone else
 * changed the environment in between, the write is rejected with a conflict
 * rather than silently overwriting their edit.
 */




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

/**
 * Refuse a model-bearing write against a deployment that cannot accept one.
 *
 * The CLI ships independently of the platform, so `modelId` may be a field the
 * target deployment's validator has never heard of — which surfaces there as an
 * opaque "unexpected argument" rather than as anything a user can act on. Ask
 * first and fail with a sentence that names the cause.
 *
 * ONLY when model input was actually supplied. An ordinary `environments
 * create` has no reason to pay for a preflight round-trip, and a CLI that got
 * slower for everyone in order to guard a field most calls never send would be
 * a bad trade.
 *
 * A preflight that itself fails remains an operational error. The capability
 * route answers `false` for an old backend, so collapsing auth/network failures
 * into "unsupported" would hide the real problem from the caller.
 */
async function assertModelOverridesSupported(
  options: PlatformOptions,
  timeoutMs: number,
  args: { supplied: boolean; project?: string }
): Promise<void> {
  if (!args.supplied) return;
  const result = await runPlatformCommand(
    options,
    timeoutMs,
    ({ client, signal }) =>
      getEnvironmentCapabilitiesOperation.execute(
        { project: args.project },
        { client, signal }
      ),
    { announce: false }
  );
  const supported = result.capabilities.modelOverrides;
  if (!supported) {
    throw usageError(
      'This MCPJam deployment does not support environment model overrides. Upgrade the platform, or omit --model / --clear-model / "modelId".'
    );
  }
}

/**
 * The project the command will actually write to, in the SAME precedence the
 * write itself uses: `--project`, then the JSON body's `project`, then
 * `MCPJAM_PROJECT`, a project link, then automatic selection.
 */
function resolveEnvironmentProject(
  options: { project?: string },
  body: Record<string, unknown> = {}
) {
  if (body.project !== undefined && typeof body.project !== "string") {
    throw usageError(
      '"project" must be a string when supplied in JSON input.'
    );
  }
  return resolveCloudProjectArgs(options, {
    inputProject: body.project,
  });
}

function projectFields(resolved: { project?: string }): { project?: string } {
  return resolved.project !== undefined ? { project: resolved.project } : {};
}

/** Read a JSON object from --file (literal path or `-` for stdin) / --json. */
function loadJsonObject(options: {
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
    throw usageError("Environment input must be a JSON object.");
  }
  return base as Record<string, unknown>;
}

/**
 * Commander gives us option values as strings. The revision is a precondition,
 * not a hint, so reject anything that isn't a clean non-negative integer rather
 * than letting `NaN` reach the API as a silently-failing check.
 */
function parseRevision(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw usageError(
      "--expected-revision must be a non-negative integer (read it from `mcpjam cloud environments get`)."
    );
  }
  return value;
}

export function registerEnvironmentsCommands(program: Command): void {
  const environments = program
    .command("environments")
    .description(
      "List, create, and manage the project environments (host + servers + pinned skills/plugins) in your hosted MCPJam projects"
    );

      environments
      .command("list")
      .description("List the project environments in a project")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
      .option(
        "--include-archived",
        "Include archived environments (needed to find one to restore)"
      ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        includeArchived?: boolean;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runCloudOp(
        command,
        options,
        ({ client, signal }, project) =>
          listEnvironmentsOperation.execute(
            {
              ...project,
              ...(options.includeArchived ? { includeArchived: true } : {}),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

      environments
      .command("get")
      .description(
        "Show one environment's settings and its current revision (pass that revision to update/archive/restore)"
      )
      .requiredOption("--environment <id-or-name>", "Environment name or ID")
      .option("--project <id-or-name>", "Project name or ID").action(
    async (
      options: PlatformOptions & { project?: string; environment: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runCloudOp(
        command,
        options,
        ({ client, signal }, project) =>
          getEnvironmentOperation.execute(
            { ...project, environment: options.environment },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

      environments
      .command("resolve")
      .description(
        "Preview what an environment resolves to right now: host config, closed server set, and pinned plugin versions"
      )
      .requiredOption("--environment <id-or-name>", "Environment name or ID")
      .option("--project <id-or-name>", "Project name or ID").action(
    async (
      options: PlatformOptions & { project?: string; environment: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runCloudOp(
        command,
        options,
        ({ client, signal }, project) =>
          resolveEnvironmentOperation.execute(
            { ...project, environment: options.environment },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

      environments
      .command("create")
      .description(
        "Create a project environment (requires project admin). Body fields may be supplied via --file/--json"
      )
      .option("--project <id-or-name>", "Project name or ID")
      .option("--name <name>", "Display name for the new environment")
      .option("--host-id <id>", "ID of the host this environment runs against")
      .option("--description <text>", "Optional description")
      .option(
        "--model <id>",
        "Model this environment runs, overriding the model pinned on its host. Omit to inherit the host's. Stored verbatim — pass exactly the id the provider request should carry"
      )
      .option(
        "--sandbox-image <id>",
        "Project-shared sandbox image (see `mcpjam cloud images`) to pin: eval runs boot a fresh sandbox from it"
      )
      .option(
        "--file <path>",
        "Environment JSON file with any of name/hostId/description/serverAttachmentId/modelId/skillSelection/pluginVersionIds/sandboxImageId (or - for stdin)"
      )
      .option("--json <json>", "Inline environment JSON (or @file, or -)").action(
    async (
      options: PlatformOptions & {
        project?: string;
        name?: string;
        hostId?: string;
        description?: string;
        model?: string;
        sandboxImage?: string;
        file?: string;
        json?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      // Explicit flags win over the same key in the JSON body, so a scripted
      // template file can be reused with a per-run --name override.
      const body = loadJsonObject(options) ?? {};
      // Version skew: a deployment that predates model overrides rejects an
      // unknown `modelId` with an opaque validator error. Ask first, and only
      // when the caller actually supplied model input — an ordinary create has
      // no reason to pay for a round-trip.
      const resolved = resolveEnvironmentProject(options, body);
      const project = projectFields(resolved);
      await assertModelOverridesSupported(
        platformOptionsOf(command),
        globalOptions.timeout,
        {
        supplied: options.model !== undefined || "modelId" in body,
        ...project,
      });
      const input = validateInput(createEnvironmentOperation, {
        ...body,
        ...project,
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.hostId !== undefined ? { hostId: options.hostId } : {}),
        ...(options.description !== undefined
          ? { description: options.description }
          : {}),
        ...(options.model !== undefined ? { modelId: options.model } : {}),
        ...(options.sandboxImage !== undefined
          ? { sandboxImageId: options.sandboxImage }
          : {}),
      });
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          createEnvironmentOperation.execute(input, { client, signal }),
        { projectScope: resolved.projectScope, cloudScope: resolved.projectScope }
      );
      writeResult(result, globalOptions.format);
    }
  );

      environments
      .command("ensure-adhoc")
      .description(
        "Get or create an UNNAMED environment for a composed stack. Deduplicated by content: the same stack always returns the same environment"
      )
      .requiredOption(
        "--host <id-or-name>",
        "Host the composed stack runs as — the client whose configuration a run is stamped with"
      )
      .option("--project <id-or-name>", "Project name or ID")
      .option(
        "--server-group <id>",
        "Standalone server group to pin (omit to use the host's own servers)"
      )
      .option(
        "--model <id>",
        "Model to run instead of the host's pinned one (stored verbatim)"
      )
      .option(
        "--computer <id-or-name>",
        "Project-shared sandbox image to pin, so runs boot a fresh computer from it"
      )
      .option(
        "--skill <id...>",
        "Project-shared skill IDs to pin on the composed stack"
      ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        host: string;
        serverGroup?: string;
        model?: string;
        computer?: string;
        skill?: string[];
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const resolved = resolveEnvironmentProject(options);
      const input = validateInput(ensureAdhocEnvironmentOperation, {
        ...projectFields(resolved),
        host: options.host,
        ...(options.serverGroup !== undefined
          ? { serverGroup: options.serverGroup }
          : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.computer !== undefined
          ? { computer: options.computer }
          : {}),
        ...(options.skill?.length
          ? { skills: { mode: "explicit", skillIds: options.skill } }
          : {}),
      });
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          ensureAdhocEnvironmentOperation.execute(input, { client, signal }),
        { projectScope: resolved.projectScope, cloudScope: resolved.projectScope }
      );
      writeResult(result, globalOptions.format);
    }
  );

      environments
      .command("name")
      .description(
        "Promote an UNNAMED (ad-hoc) environment to a named one, in place — the same id every existing run points at"
      )
      .requiredOption(
        "--environment <id>",
        "The ad-hoc environment to promote, by ID (an unnamed environment has no name to select it by)"
      )
      .requiredOption("--name <name>", "Display name for the promoted environment")
      .requiredOption(
        "--expected-revision <n>",
        "The revision you last read; a stale value is rejected instead of overwriting a concurrent edit"
      )
      .option("--project <id-or-name>", "Project name or ID")
      .option("--description <text>", "Optional description").action(
    async (
      options: PlatformOptions & {
        project?: string;
        environment: string;
        name: string;
        expectedRevision: string;
        description?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const resolved = resolveEnvironmentProject(options);
      const input = validateInput(nameEnvironmentOperation, {
        ...projectFields(resolved),
        environment: options.environment,
        name: options.name,
        expectedRevision: parseRevision(options.expectedRevision),
        ...(options.description !== undefined
          ? { description: options.description }
          : {}),
      });
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          nameEnvironmentOperation.execute(input, { client, signal }),
        { projectScope: resolved.projectScope, cloudScope: resolved.projectScope }
      );
      writeResult(result, globalOptions.format);
    }
  );

      environments
      .command("update")
      .description(
        "Edit an environment. Only the fields you pass change; use --clear-model, or --file/--json with a null value, to clear serverAttachmentId, modelId, skillSelection, pluginVersionIds, or sandboxImageId"
      )
      .requiredOption("--environment <id-or-name>", "Environment name or ID")
      .requiredOption(
        "--expected-revision <n>",
        "The revision you last read (from `environments get`); a stale value is rejected instead of overwriting a concurrent edit"
      )
      .option("--project <id-or-name>", "Project name or ID")
      .option("--name <name>", "New display name")
      .option("--host-id <id>", "New host for this environment")
      .option(
        "--description <text>",
        "New description (empty string clears it)"
      )
      .option(
        "--model <id>",
        "New model override, replacing the host's pinned model"
      )
      .option(
        "--clear-model",
        "Clear the model override so the environment inherits its host's model again"
      )
      .option(
        "--sandbox-image <id>",
        "New sandbox-image pin (clear via --json '{\"sandboxImageId\": null}')"
      )
      .option(
        "--file <path>",
        "Environment JSON file with the fields to change (or - for stdin)"
      )
      .option("--json <json>", "Inline environment JSON (or @file, or -)").action(
    async (
      options: PlatformOptions & {
        project?: string;
        environment: string;
        expectedRevision: string;
        name?: string;
        hostId?: string;
        description?: string;
        model?: string;
        clearModel?: boolean;
        sandboxImage?: string;
        file?: string;
        json?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const body = loadJsonObject(options) ?? {};
      // The two flags say opposite things about the same field, and picking a
      // winner would silently discard half of what was asked for.
      if (options.model !== undefined && options.clearModel) {
        throw usageError("Provide either --model or --clear-model, not both.");
      }
      const resolved = resolveEnvironmentProject(options, body);
      const project = projectFields(resolved);
      await assertModelOverridesSupported(
        platformOptionsOf(command),
        globalOptions.timeout,
        {
        supplied:
          options.model !== undefined ||
          options.clearModel === true ||
          "modelId" in body,
        ...project,
      });
      const input = validateInput(updateEnvironmentOperation, {
        ...body,
        ...project,
        environment: options.environment,
        expectedRevision: parseRevision(options.expectedRevision),
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.hostId !== undefined ? { hostId: options.hostId } : {}),
        ...(options.description !== undefined
          ? { description: options.description }
          : {}),
        // `--clear-model` is the flag spelling of the JSON `"modelId": null`
        // both this command and the API already accept; neither is removed.
        ...(options.clearModel ? { modelId: null } : {}),
        ...(options.model !== undefined ? { modelId: options.model } : {}),
        ...(options.sandboxImage !== undefined
          ? { sandboxImageId: options.sandboxImage }
          : {}),
      });
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          updateEnvironmentOperation.execute(input, { client, signal }),
        { projectScope: resolved.projectScope, cloudScope: resolved.projectScope }
      );
      writeResult(result, globalOptions.format);
    }
  );

      environments
      .command("archive")
      .description(
        "Archive an environment (reversible; frees its name for a new one)"
      )
      .requiredOption("--environment <id-or-name>", "Environment name or ID")
      .requiredOption(
        "--expected-revision <n>",
        "The revision you last read (from `environments get`)"
      )
      .option("--project <id-or-name>", "Project name or ID").action(
    async (
      options: PlatformOptions & {
        project?: string;
        environment: string;
        expectedRevision: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runCloudOp(
        command,
        options,
        ({ client, signal }, project) =>
          archiveEnvironmentOperation.execute(
            {
              ...project,
              environment: options.environment,
              expectedRevision: parseRevision(options.expectedRevision),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

      environments
      .command("restore")
      .description(
        "Restore an archived environment. Plugin pins whose version no longer exists are dropped — check the returned pluginVersionIds"
      )
      .requiredOption("--environment <id-or-name>", "Environment name or ID")
      .requiredOption(
        "--expected-revision <n>",
        "The revision you last read (from `environments get --include-archived` via list)"
      )
      .option("--project <id-or-name>", "Project name or ID").action(
    async (
      options: PlatformOptions & {
        project?: string;
        environment: string;
        expectedRevision: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runCloudOp(
        command,
        options,
        ({ client, signal }, project) =>
          restoreEnvironmentOperation.execute(
            {
              ...project,
              environment: options.environment,
              expectedRevision: parseRevision(options.expectedRevision),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );
}
