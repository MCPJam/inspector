import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  buildImageOperation,
  createImageOperation,
  deleteImageOperation,
  getImageOperation,
  listImagesOperation,
  listImageBuildsOperation,
  promoteImageOperation,
  resetComputerOperation,
  updateImageOperation,
  useImageOperation,
  PlatformApiError,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import { usageError, writeResult } from "../lib/output.js";
import { buildPlatformClient, toCliError } from "../lib/platform-client.js";
import { getGlobalOptions } from "../lib/server-config.js";

type PlatformOptions = {
  apiKey?: string;
  apiUrl?: string;
};

function addPlatformOptions(command: Command): Command {
  return command
    .option("--api-key <key>", "MCPJam sk_ API key (overrides MCPJAM_API_KEY)")
    .option(
      "--api-url <url>",
      "MCPJam API base URL (defaults to https://app.mcpjam.com/api/v1)"
    );
}

async function runPlatformCommand<TOutput>(
  options: PlatformOptions,
  timeoutMs: number,
  execute: (context: {
    client: ReturnType<typeof buildPlatformClient>["client"];
    signal: AbortSignal;
  }) => Promise<TOutput>
): Promise<TOutput> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort(
      new PlatformApiError(
        `Request timed out after ${timeoutMs}ms`,
        "TIMEOUT",
        {
          status: 0,
        }
      )
    );
  }, timeoutMs);
  timeoutHandle.unref?.();

  try {
    const { client } = buildPlatformClient({ ...options, timeoutMs });
    return await execute({ client, signal: controller.signal });
  } catch (error) {
    if (
      controller.signal.aborted &&
      controller.signal.reason instanceof PlatformApiError
    ) {
      throw toCliError(controller.signal.reason);
    }
    throw toCliError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/** Read Dockerfile TEXT (not JSON) from a path, or stdin when `--file -`. */
function loadDockerfileText(file: string): string {
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
      "List, build, and manage custom Computer sandbox images (Dockerfiles) in your hosted MCPJam projects"
    );

  addPlatformOptions(
    env
      .command("list")
      .description("List the sandbox images in a project")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
  ).action(async (options: PlatformOptions & { project?: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        listImagesOperation.execute(
          { project: options.project },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

  addPlatformOptions(
    env
      .command("get")
      .description(
        "Show one sandbox image's Dockerfile and latest build status"
      )
      .requiredOption("--image <id-or-name>", "Sandbox image name or ID")
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & { project?: string; image: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          getImageOperation.execute(
            { project: options.project, image: options.image },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    env
      .command("create")
      .description(
        "Create a sandbox image from a Dockerfile (--file, or - for stdin)"
      )
      .requiredOption("--name <name>", "Display name for the new sandbox image")
      .requiredOption(
        "--file <path>",
        "Dockerfile path, or - to read it from stdin"
      )
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        name: string;
        file: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const dockerfile = loadDockerfileText(options.file);
      const input = validateInput(createImageOperation, {
        project: options.project,
        name: options.name,
        dockerfile,
      });
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          createImageOperation.execute(input, { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    env
      .command("edit")
      .description("Edit a sandbox image's name and/or Dockerfile")
      .requiredOption("--image <id-or-name>", "Sandbox image name or ID")
      .option("--project <id-or-name>", "Project name or ID")
      .option("--name <name>", "New display name")
      .option("--file <path>", "Replacement Dockerfile path (or - for stdin)")
  ).action(
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
      const dockerfile =
        options.file !== undefined
          ? loadDockerfileText(options.file)
          : undefined;
      const input = validateInput(updateImageOperation, {
        project: options.project,
        image: options.image,
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(dockerfile !== undefined ? { dockerfile } : {}),
      });
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          updateImageOperation.execute(input, { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    env
      .command("build")
      .description(
        "Build the sandbox image (async — poll `images logs` for status)"
      )
      .requiredOption("--image <id-or-name>", "Sandbox image name or ID")
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & { project?: string; image: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          buildImageOperation.execute(
            { project: options.project, image: options.image },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    env
      .command("logs")
      .description(
        "Show a sandbox image's builds (newest first) with their log preview"
      )
      .requiredOption("--image <id-or-name>", "Sandbox image name or ID")
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & { project?: string; image: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          listImageBuildsOperation.execute(
            { project: options.project, image: options.image },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    env
      .command("use")
      .description(
        "Boot your computer from this sandbox image (rebuilds it — installed files are wiped)"
      )
      .requiredOption("--image <id-or-name>", "Sandbox image name or ID")
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & { project?: string; image: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          useImageOperation.execute(
            { project: options.project, image: options.image },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    env
      .command("reset")
      .description(
        "Reset your computer to its current image (wipes mutable state)"
      )
      .option("--project <id-or-name>", "Project name or ID")
  ).action(async (options: PlatformOptions & { project?: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        resetComputerOperation.execute(
          { project: options.project },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

  addPlatformOptions(
    env
      .command("promote")
      .description(
        "Share a personal-draft sandbox image with the whole project (admin only)"
      )
      .requiredOption("--image <id-or-name>", "Sandbox image name or ID")
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & { project?: string; image: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          promoteImageOperation.execute(
            { project: options.project, image: options.image },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    env
      .command("delete")
      .description("Permanently delete a sandbox image from a project")
      .requiredOption("--image <id-or-name>", "Sandbox image name or ID")
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & { project?: string; image: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          deleteImageOperation.execute(
            { project: options.project, image: options.image },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );
}
