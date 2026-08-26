import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  buildImageOperation,
  createImageOperation,
  validateImageBlueprintOperation,
  deleteImageOperation,
  getImageOperation,
  listImagesOperation,
  listImageBuildsOperation,
  promoteImageOperation,
  resetComputerOperation,
  updateImageOperation,
  useImageOperation,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import { usageError, writeResult } from "../lib/output.js";
import {
  platformOptionsOf,
  runPlatformOperation as runPlatformCommand,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { resolveCloudProjectArgs } from "../lib/cloud-scope.js";
import { getGlobalOptions } from "../lib/server-config.js";




/** Read blueprint YAML TEXT (not JSON) from a path, or stdin when `--file -`. */
function loadBlueprintText(file: string): string {
  let text: string;
  try {
    text = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  } catch (error) {
    throw usageError(`Failed to read --file "${file}".`, {
      source: error instanceof Error ? error.message : String(error),
    });
  }
  if (text.trim() === "") throw usageError("--file input is empty.");
  return text;
}

/** Validate a merged input object against an operation's schema. */
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

export function registerImagesCommands(program: Command): void {
  const env = program
    .command("images")
    .description(
      "List, build, and manage custom Computer sandbox images (blueprints) in your hosted MCPJam projects"
    );

      env
      .command("list")
      .description("List the sandbox images in a project")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      ).action(async (options: PlatformOptions & { project?: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      platformOptionsOf(command),
      globalOptions.timeout,
      ({ client, signal }) =>
        listImagesOperation.execute(
          { project: resolveCloudProjectArgs(options).project },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

      env
      .command("get")
      .description(
        "Show one sandbox image's blueprint and latest build status"
      )
      .requiredOption("--image <id-or-name>", "Sandbox image name or ID")
      .option("--project <id-or-name>", "Project name or ID").action(
    async (
      options: PlatformOptions & { project?: string; image: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          getImageOperation.execute(
            { project: resolveCloudProjectArgs(options).project, image: options.image },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

      env
      .command("create")
      .description(
        "Create a sandbox image from a blueprint YAML file (--file, or - for stdin)"
      )
      .requiredOption("--name <name>", "Display name for the new sandbox image")
      .requiredOption(
        "--file <path>",
        "Blueprint YAML path, or - to read it from stdin"
      )
      .option("--project <id-or-name>", "Project name or ID").action(
    async (
      options: PlatformOptions & {
        project?: string;
        name: string;
        file: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const blueprint = loadBlueprintText(options.file);
      const input = validateInput(createImageOperation, {
        project: resolveCloudProjectArgs(options).project,
        name: options.name,
        blueprint,
      });
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          createImageOperation.execute(input, { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );

      env
      .command("validate")
      .description(
        "Lint a blueprint YAML file with the MCPJam Cloud image linter without saving it (--file, or - for stdin)"
      )
      .requiredOption(
        "--file <path>",
        "Blueprint YAML path, or - to read it from stdin"
      )
      .option("--project <id-or-name>", "Project name or ID").action(
    async (
      options: PlatformOptions & { project?: string; file: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const blueprint = loadBlueprintText(options.file);
      const input = validateInput(validateImageBlueprintOperation, {
        project: resolveCloudProjectArgs(options).project,
        blueprint,
      });
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          validateImageBlueprintOperation.execute(input, { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );

      env
      .command("edit")
      .description("Edit a sandbox image's name and/or blueprint")
      .requiredOption("--image <id-or-name>", "Sandbox image name or ID")
      .option("--project <id-or-name>", "Project name or ID")
      .option("--name <name>", "New display name")
      .option("--file <path>", "Replacement blueprint YAML path (or - for stdin)").action(
    async (
      options: PlatformOptions & {
        project?: string;
        image: string;
        name?: string;
        file?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const blueprint =
        options.file !== undefined
          ? loadBlueprintText(options.file)
          : undefined;
      const input = validateInput(updateImageOperation, {
        project: resolveCloudProjectArgs(options).project,
        image: options.image,
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(blueprint !== undefined ? { blueprint } : {}),
      });
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          updateImageOperation.execute(input, { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );

      env
      .command("build")
      .description(
        "Build the sandbox image (async — poll `images logs` for status)"
      )
      .requiredOption("--image <id-or-name>", "Sandbox image name or ID")
      .option("--project <id-or-name>", "Project name or ID").action(
    async (
      options: PlatformOptions & { project?: string; image: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          buildImageOperation.execute(
            { project: resolveCloudProjectArgs(options).project, image: options.image },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

      env
      .command("logs")
      .description(
        "Show a sandbox image's builds (newest first) with their log preview"
      )
      .requiredOption("--image <id-or-name>", "Sandbox image name or ID")
      .option("--project <id-or-name>", "Project name or ID").action(
    async (
      options: PlatformOptions & { project?: string; image: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          listImageBuildsOperation.execute(
            { project: resolveCloudProjectArgs(options).project, image: options.image },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

      env
      .command("use")
      .description(
        "Boot your computer from this sandbox image (rebuilds it — installed files are wiped)"
      )
      .requiredOption("--image <id-or-name>", "Sandbox image name or ID")
      .option("--project <id-or-name>", "Project name or ID").action(
    async (
      options: PlatformOptions & { project?: string; image: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          useImageOperation.execute(
            { project: resolveCloudProjectArgs(options).project, image: options.image },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

      env
      .command("reset")
      .description(
        "Reset your computer to its current image (wipes mutable state)"
      )
      .option("--project <id-or-name>", "Project name or ID").action(async (options: PlatformOptions & { project?: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      platformOptionsOf(command),
      globalOptions.timeout,
      ({ client, signal }) =>
        resetComputerOperation.execute(
          { project: resolveCloudProjectArgs(options).project },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

      env
      .command("promote")
      .description(
        "Share a personal-draft sandbox image with the whole project (admin only)"
      )
      .requiredOption("--image <id-or-name>", "Sandbox image name or ID")
      .option("--project <id-or-name>", "Project name or ID").action(
    async (
      options: PlatformOptions & { project?: string; image: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          promoteImageOperation.execute(
            { project: resolveCloudProjectArgs(options).project, image: options.image },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

      env
      .command("delete")
      .description("Permanently delete a sandbox image from a project")
      .requiredOption("--image <id-or-name>", "Sandbox image name or ID")
      .option("--project <id-or-name>", "Project name or ID").action(
    async (
      options: PlatformOptions & { project?: string; image: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          deleteImageOperation.execute(
            { project: resolveCloudProjectArgs(options).project, image: options.image },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );
}
