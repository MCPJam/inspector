import type { Command } from "commander";
import {
  connectProjectServerOperation,
  getProjectServerConnectionStatusOperation,
  createProjectOperation,
  deleteProjectOperation,
  listProjectsOperation,
  listProjectServersOperation,
  createProjectServerOperation,
  getProjectServerOperation,
  updateProjectServerOperation,
  deleteProjectServerOperation,
  PlatformApiError,
  showServersOperation,
  updateProjectOperation,
} from "@mcpjam/sdk/platform";
import {
  formatProjectServersHuman,
  formatProjectsHuman,
  formatShowServersHuman,
} from "../lib/projects-render.js";
import { writeResult } from "../lib/output.js";
import { buildPlatformClient, toCliError } from "../lib/platform-client.js";
import { getGlobalOptions } from "../lib/server-config.js";
import { openUrlInBrowser } from "@mcpjam/sdk";

type PlatformOptions = {
  apiKey?: string;
  apiUrl?: string;
  project?: string;
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
    // When OUR deadline fired, surface the armed TIMEOUT error: depending
    // on the fetch implementation, the rejection may be a bare AbortError
    // that would otherwise map to INTERNAL_ERROR.
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

export function registerProjectsCommands(program: Command): void {
  const projects = program
    .command("projects")
    .description(
      "Operate the MCP servers saved in your hosted MCPJam projects"
    );

  addPlatformOptions(
    projects.command("list").description("List the projects you can access")
  ).action(async (options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        listProjectsOperation.execute({}, { client, signal })
    );

    if (globalOptions.format === "human") {
      process.stdout.write(`${formatProjectsHuman(result.items)}\n`);
    } else {
      // Operation payload verbatim — keeps pagination fields like
      // nextCursor, matching the sibling commands and the MCP tool.
      writeResult(result, globalOptions.format);
    }
  });

  addPlatformOptions(
    projects
      .command("create")
      .description("Create a hosted MCPJam project")
      .requiredOption("--name <name>", "Project name")
      .option("--description <text>", "Project description")
      .option("--organization-id <id>", "Organization ID")
      .option("--visibility <visibility>", "public or private")
  ).action(
    async (
      options: PlatformOptions & {
        name: string;
        description?: string;
        organizationId?: string;
        visibility?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const input = createProjectOperation.inputSchema.parse({
        name: options.name,
        ...(options.description === undefined
          ? {}
          : { description: options.description }),
        ...(options.organizationId === undefined
          ? {}
          : { organizationId: options.organizationId }),
        ...(options.visibility === undefined
          ? {}
          : { visibility: options.visibility }),
      });
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          createProjectOperation.execute(input, { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    projects
      .command("update")
      .description("Update project metadata")
      .requiredOption("--project <id-or-name>", "Project name or ID")
      .option("--name <name>", "New project name")
      .option("--description <text>", "New project description")
      .option("--visibility <visibility>", "public or private")
  ).action(
    async (
      options: PlatformOptions & {
        project: string;
        name?: string;
        description?: string;
        visibility?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const input = updateProjectOperation.inputSchema.parse({
        project: options.project,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.description === undefined
          ? {}
          : { description: options.description }),
        ...(options.visibility === undefined
          ? {}
          : { visibility: options.visibility }),
      });
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          updateProjectOperation.execute(input, { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    projects
      .command("delete")
      .description("Delete a project and its project-owned resources")
      .requiredOption("--project <id-or-name>", "Project name or ID")
  ).action(async (options: PlatformOptions & { project: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const input = deleteProjectOperation.inputSchema.parse({
      project: options.project,
    });
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        deleteProjectOperation.execute(input, { client, signal })
    );
    writeResult(result, globalOptions.format);
  });

  const servers = addPlatformOptions(
    projects
      .command("servers")
      .alias("server")
      .description("List and manage the servers saved in a project")
  ).option(
    "--project <id-or-name>",
    "Project name or ID (defaults to the most recently updated project)"
  );
  servers.action(async (options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        listProjectServersOperation.execute(
          { project: options.project },
          { client, signal }
        )
    );

    if (globalOptions.format === "human") {
      process.stdout.write(`${formatProjectServersHuman(result)}\n`);
    } else {
      writeResult(result, globalOptions.format);
    }
  });

  const parseBody = (raw: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  };

  addPlatformOptions(
    servers
      .command("create")
      .alias("add")
      .description("Create a saved MCP server")
      .requiredOption("--project <id-or-name>", "Project name or ID")
      .requiredOption("--body <json>", "Server JSON body")
  ).action(async (options: PlatformOptions & { body: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        createProjectServerOperation.execute(
          { project: options.project, body: parseBody(options.body) as never },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

  addPlatformOptions(
    servers
      .command("get")
      .description("Get one saved MCP server")
      .requiredOption("--project <id-or-name>", "Project name or ID")
      .requiredOption("--server <id>", "Server ID")
  ).action(async (options: PlatformOptions & { server: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        getProjectServerOperation.execute(
          { project: options.project, serverId: options.server },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

  addPlatformOptions(
    servers
      .command("update")
      .description("Update one saved MCP server")
      .requiredOption("--project <id-or-name>", "Project name or ID")
      .requiredOption("--server <id>", "Server ID")
      .requiredOption("--body <json>", "Patch JSON body")
  ).action(
    async (
      options: PlatformOptions & { server: string; body: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          updateProjectServerOperation.execute(
            {
              project: options.project,
              serverId: options.server,
              body: parseBody(options.body),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    servers
      .command("delete")
      .alias("remove")
      .description("Delete one saved MCP server")
      .requiredOption("--project <id-or-name>", "Project name or ID")
      .requiredOption("--server <id>", "Server ID")
  ).action(async (options: PlatformOptions & { server: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        deleteProjectServerOperation.execute(
          { project: options.project, serverId: options.server },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

  addPlatformOptions(
    servers
      .command("connect")
      .description(
        "Connect an MCP server URL to a project, authorizing in a browser if needed"
      )
      .requiredOption("--url <url>", "MCP server URL to connect")
      .option("--project <id-or-name>", "Project name or ID")
      .option(
        "--server <id>",
        "Existing server ID, when the project has several on this URL"
      )
      .option("--name <name>", "Name for the server, if one is created")
      .option("--reauthorize", "Force a fresh authorization")
      .option("--no-browser", "Print the authorization link instead of opening it")
      .option("--no-wait", "Return as soon as the request is created")
  ).action(
    async (
      options: PlatformOptions & {
        url: string;
        server?: string;
        name?: string;
        reauthorize?: boolean;
        browser?: boolean;
        wait?: boolean;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);

      // Parsed at the keyboard, like every sibling command here. Commander
      // hands back whatever was typed, so without this `--url " "` and
      // `--url file:///etc/passwd` travel all the way to the API to be
      // rejected there — a slower, vaguer error for a mistake visible now.
      const input = connectProjectServerOperation.inputSchema.parse({
        url: options.url,
        project: options.project,
        serverId: options.server,
        name: options.name,
        reauthorize: options.reauthorize,
      });

      const created = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          connectProjectServerOperation.execute(input, { client, signal })
      );

      if (created.handoffUrl) {
        // Printed even when we open it: a browser that fails to launch, or
        // launches on the wrong machine over SSH, otherwise leaves the user
        // with a request they cannot finish and no link to finish it with.
        process.stderr.write(
          `Open this link to finish connecting:\n  ${created.handoffUrl}\n`
        );
        if (options.browser !== false) {
          await openUrlInBrowser(created.handoffUrl).catch(() => {
            process.stderr.write(
              "Could not open a browser automatically — open the link above.\n"
            );
          });
        }
      }

      if (options.wait === false || isTerminalConnectionStatus(created.status)) {
        if (options.wait === false && !isTerminalConnectionStatus(created.status)) {
          process.stderr.write(
            `Not waiting. Follow it with:\n  mcpjam projects server connect-status --request ${created.connectionRequestId}\n`
          );
        }
        writeResult(created, globalOptions.format);
        return;
      }

      const settled = await pollConnection(
        options,
        globalOptions.timeout,
        created.connectionRequestId,
        created.expiresAt
      );
      writeResult(settled.result, globalOptions.format);
      if (settled.gaveUp) {
        // A script must be able to tell "it finished" from "I stopped
        // watching". Returning the last poll silently made those identical.
        process.stderr.write(
          `Stopped waiting; the request is still ${settled.result.status} and continues in the cloud.\n` +
            `  mcpjam projects server connect-status --request ${created.connectionRequestId}\n`
        );
        process.exitCode = 1;
      }
    }
  );

  addPlatformOptions(
    servers
      .command("connect-status")
      .description("Check a connection request started by `server connect`")
      .requiredOption("--request <id>", "Connection request id (scr_…)")
  ).action(
    async (options: PlatformOptions & { request: string }, command) => {
      const globalOptions = getGlobalOptions(command);
      const input = getProjectServerConnectionStatusOperation.inputSchema.parse({
        connectionRequestId: options.request,
      });
      const payload = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          getProjectServerConnectionStatusOperation.execute(input, {
            client,
            signal,
          })
      );
      writeResult(payload, globalOptions.format);
    }
  );

  addPlatformOptions(
    projects
      .command("status")
      .description(
        "Health-check every server in a project (hosted doctor per server)"
      )
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
  ).action(async (options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const payload = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        showServersOperation.execute(
          { project: options.project },
          { client, signal }
        )
    );

    if (globalOptions.format === "human") {
      process.stdout.write(`${formatShowServersHuman(payload)}\n`);
    } else {
      writeResult(payload, globalOptions.format);
    }
    // Exit 0 even with unreachable servers: this is a status report, not an
    // assertion. CI gating can parse the summary from the JSON payload.
  });
}

const TERMINAL_CONNECTION_STATUSES = new Set([
  "ready",
  "failed",
  "expired",
  "cancelled",
]);

function isTerminalConnectionStatus(status: string): boolean {
  return TERMINAL_CONNECTION_STATUSES.has(status);
}

/** How long to keep watching when the server did not say when it expires. */
const FALLBACK_POLL_WINDOW_MS = 60 * 60 * 1000;

/**
 * Poll until the request settles.
 *
 * Backs off from 2s to 10s: the first few seconds are when discovery finishes
 * for an unauthenticated server, and after that the flow is waiting on a human
 * at a browser, where a tighter interval buys nothing.
 *
 * THE DEADLINE COMES FROM THE SERVER. The request's own `expiresAt` is the
 * authority on how long it can still be finished; a duplicated 60-minute
 * constant here would silently disagree the moment that TTL changed, and would
 * disagree in the wrong direction — watching a request that already expired, or
 * abandoning one that had not. The constant above is only for a response that
 * omitted the field.
 *
 * CTRL-C STOPS THE POLLING, NOT THE REQUEST. The request lives in the cloud, so
 * a user who gives up on watching can still open the link and finish. Saying so
 * matters: the default reading of Ctrl-C is "I cancelled it", and acting on that
 * belief means abandoning a request that was about to succeed.
 *
 * Returns `gaveUp` so the caller can tell "it finished" from "I stopped
 * watching" — a distinction a script cannot recover from the status alone.
 */
async function pollConnection(
  options: PlatformOptions,
  timeoutMs: number,
  connectionRequestId: string,
  expiresAt?: string | null
): Promise<{
  result: Awaited<
    ReturnType<typeof getProjectServerConnectionStatusOperation.execute>
  >;
  gaveUp: boolean;
}> {
  let delayMs = 2_000;

  const expiryMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const deadline = Number.isFinite(expiryMs)
    ? expiryMs
    : Date.now() + FALLBACK_POLL_WINDOW_MS;

  let interrupted = false;
  /** Wakes the backoff sleep so Ctrl-C is felt now rather than in up to ten
   * seconds. Without it the handler sets a flag that nothing reads until the
   * timer fires, and the terminal looks hung at exactly the moment the user
   * asked for it back. */
  let wakeSleep: (() => void) | undefined;
  const onInterrupt = () => {
    interrupted = true;
    process.stderr.write(
      "\nStopped watching. The request continues in the cloud — open the link above to finish it.\n"
    );
    wakeSleep?.();
  };
  // Registered only for the duration of the wait, and `once`, so a second
  // Ctrl-C still terminates the process the way a user expects.
  process.once("SIGINT", onInterrupt);

  try {
    for (;;) {
      const current = await runPlatformCommand(
        options,
        timeoutMs,
        ({ client, signal }) =>
          getProjectServerConnectionStatusOperation.execute(
            { connectionRequestId },
            { client, signal }
          )
      );

      if (isTerminalConnectionStatus(current.status)) {
        return { result: current, gaveUp: false };
      }
      if (interrupted) return { result: current, gaveUp: true };
      // Checked BEFORE the sleep. Checking after it meant spending a round trip
      // to discover the deadline had passed while we were asleep.
      if (Date.now() + delayMs > deadline) {
        return { result: current, gaveUp: true };
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        wakeSleep = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wakeSleep = undefined;
      if (interrupted) {
        return { result: current, gaveUp: true };
      }
      delayMs = Math.min(delayMs * 1.5, 10_000);
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}
