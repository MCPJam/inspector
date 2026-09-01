import type { Command } from "commander";
import {
  connectProjectServerOperation,
  getProjectServerConnectionStatusOperation,
  cancelProjectServerConnectionOperation,
  createProjectOperation,
  deleteProjectOperation,
  getCapabilitiesOperation,
  listProjectsOperation,
  listProjectServersOperation,
  createProjectServerOperation,
  getProjectServerOperation,
  updateProjectServerOperation,
  deleteProjectServerOperation,
  showServersOperation,
  updateProjectOperation,
} from "@mcpjam/sdk/platform";
import {
  formatProjectServersHuman,
  formatProjectsHuman,
  formatShowServersHuman,
} from "../lib/projects-render.js";
import { writeResult } from "../lib/output.js";
import { DEFAULT_PLATFORM_ORIGIN } from "../lib/platform-auth.js";
import {
  addOrgOption,
  addProjectOption,
  bindOperation,
  buildCloudClientContext,
  platformOptionsOf,
  runPlatformCommand,
  type PlatformOptions as SharedPlatformOptions,
} from "../lib/platform-command.js";
import { resolveCloudProjectArgs } from "../lib/cloud-scope.js";
import { getGlobalOptions } from "../lib/server-config.js";
import { openUrlInBrowser } from "@mcpjam/sdk";

type PlatformOptions = SharedPlatformOptions & {
  project?: string;
};

/**
 * `--project`, for the commands that cannot run without one.
 *
 * These used to be `requiredOption`, which the `servers` group's own
 * `--project` made unsatisfiable — Commander consumed the value at the group
 * and then failed the subcommand for not having it, so `projects servers get
 * --project alpha --server srv-1` could not be typed at all. Enforcing it here
 * keeps the same outcome for the same mistake (`command.error` raises the
 * `CommanderError` the CLI already maps to a usage error) while letting the
 * value arrive from wherever Commander actually put it. See
 * {@link platformOptionsOf} for why flags on the group and the leaf must be
 * merged nearest-first.
 */
function requireProject(command: Command, options: PlatformOptions): string {
  const resolved = resolveCloudProjectArgs({ project: options.project });
  if (resolved.projectScope.source === "automatic" || !resolved.project) {
    command.error("error: required option '--project <id-or-name>' not specified");
  }
  return resolved.project;
}

/**
 * Who a handoff link will belong to, and which deployment it lives on.
 *
 * WHY THIS EXISTS. A handoff link is bound to the account that created it, and
 * the browser that opens it is refused unless it is signed in to that same
 * account. Nothing in the old output said which account that was, so the two
 * ends could disagree with no warning and no way to diagnose it — most sharply
 * when an agent runs this command and relays the link to a person, because the
 * agent cannot see either side of the mismatch.
 *
 * The deployment goes on the line too. This CLI can be pointed at prod,
 * staging, or a local server, and a link only works on the one that minted it.
 *
 * BEST EFFORT, ALWAYS. The connection request already succeeded by the time
 * this runs; failing the command because a decorative lookup failed would
 * trade a working result for none. An unresolved account simply drops that
 * half of the sentence.
 */
async function resolveHandoffAudience(
  options: PlatformOptions,
  timeoutMs: number
): Promise<{ email: string | null; origin: string }> {
  try {
    const { client, webOrigin } = buildCloudClientContext(options, timeoutMs);
    try {
      const me = await client.getMe();
      return { email: me.email ?? null, origin: webOrigin };
    } catch {
      return { email: null, origin: webOrigin };
    }
  } catch {
    // `buildCloudClientContext` throws when there is no usable credential at all.
    // The request that produced the link plainly had one, so this is close to
    // unreachable — but it must not be the thing that breaks the output.
    return { email: null, origin: DEFAULT_PLATFORM_ORIGIN };
  }
}

/** The audience line, as printed. Pure, so its wording is testable without a
 * network call. */
function describeHandoffAudience(audience: {
  email: string | null;
  origin: string;
}): string {
  const host = new URL(audience.origin).host;
  return audience.email
    ? `This link belongs to ${audience.email} on ${host}. Open it in a browser signed in to that account.\n`
    : `This link belongs to the account this CLI is logged into, on ${host}. Open it in a browser signed in to that account — \`mcpjam cloud whoami\` names it.\n`;
}

export function registerProjectsCommands(program: Command): void {
  const projects = program
    .command("projects")
    .description(
      "Operate the MCP servers saved in your hosted MCPJam projects"
    );

      addOrgOption(
      projects
      .command("list")
      .description("List the projects you can access")
      // The operation has always taken this filter; the CLI had no way to pass
      // it, and no way to learn an id to pass either. `organizations list`
      // supplies the id, so the flag is finally usable end to end.
      //
      // Named `--org`, matching `projects create`. Both take an ID and only
      // an ID. (`--project` elsewhere is a name-OR-id selector.)
      ).action(async (_options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const rawOrganization = (command.opts() as { org?: string }).org;
    // A supplied-but-blank value is a typo, not "no filter". Silently widening
    // it to every accessible project is the wrong answer to a request that
    // asked to narrow — same reasoning as `requireProject` above.
    if (rawOrganization !== undefined && rawOrganization.trim() === "") {
      command.error(
        "error: option '--org <id>' cannot be empty"
      );
    }
    const organizationId = rawOrganization?.trim();
    const result = await runPlatformCommand(
      platformOptionsOf<PlatformOptions>(command),
      globalOptions.timeout,
      ({ client, signal }) =>
        listProjectsOperation.execute(
          organizationId ? { organizationId } : {},
          { client, signal }
        ),
      {
        quiet: globalOptions.quiet,
        cloudScope: organizationId
          ? { kind: "organization", organization: organizationId }
          : { kind: "all-projects" },
      }
    );

    if (globalOptions.format === "human") {
      process.stdout.write(`${formatProjectsHuman(result.items)}\n`);
    } else {
      // Operation payload verbatim — keeps pagination fields like
      // nextCursor, matching the sibling commands and the MCP tool.
      writeResult(result, globalOptions.format);
    }
  });

      addOrgOption(
      projects
      .command("create")
      .description("Create a hosted MCPJam project")
      .requiredOption("--name <name>", "Project name")
      .option("--description <text>", "Project description")
      )
      .option("--visibility <visibility>", "public or private").action(
    async (
      options: PlatformOptions & {
        name: string;
        description?: string;
        org?: string;
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
        ...(options.org === undefined
          ? {}
          : { organizationId: options.org }),
        ...(options.visibility === undefined
          ? {}
          : { visibility: options.visibility }),
      });
      const result = await runPlatformCommand(
        platformOptionsOf<PlatformOptions>(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          createProjectOperation.execute(input, { client, signal }),
        { cloudScope: { kind: "account" }, quiet: globalOptions.quiet }
      );
      writeResult(result, globalOptions.format);
    }
  );

      projects
      .command("update")
      .description("Update project metadata")
      .requiredOption("--project <id-or-name>", "Project name or ID")
      .option("--name <name>", "New project name")
      .option("--description <text>", "New project description")
      .option("--visibility <visibility>", "public or private").action(
    async (
      options: PlatformOptions & {
        name?: string;
        description?: string;
        visibility?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const platformOptions = platformOptionsOf<PlatformOptions>(command);
      const input = updateProjectOperation.inputSchema.parse({
        project: requireProject(command, platformOptions),
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.description === undefined
          ? {}
          : { description: options.description }),
        ...(options.visibility === undefined
          ? {}
          : { visibility: options.visibility }),
      });
      const result = await runPlatformCommand(
        platformOptions,
        globalOptions.timeout,
        ({ client, signal }) =>
          updateProjectOperation.execute(input, { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );

      projects
      .command("delete")
      .description("Delete a project and its project-owned resources")
      .requiredOption("--project <id-or-name>", "Project name or ID").action(async (_options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const platformOptions = platformOptionsOf<PlatformOptions>(command);
    const input = deleteProjectOperation.inputSchema.parse({
      project: requireProject(command, platformOptions),
    });
    const result = await runPlatformCommand(
      platformOptions,
      globalOptions.timeout,
      ({ client, signal }) =>
        deleteProjectOperation.execute(input, { client, signal })
    );
    writeResult(result, globalOptions.format);
  });

  bindOperation(
    addProjectOption(
      projects
        .command("capabilities")
        .description(
          "Show what you may do in a project: your role, which betas the organization has, your plan's limits, and a can-block of booleans. Ask this before scripting anything that authors, launches or publishes."
        )
    ),
    getCapabilitiesOperation,
    (options: PlatformOptions) => ({ project: options.project })
  );

  const servers =     projects
      .command("servers")
      .description("List and manage the servers saved in a project").option(
    "--project <id-or-name>",
    "Project name or ID (defaults to the most recently updated project)"
  );
  servers.action(async (_options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const platformOptions = platformOptionsOf<PlatformOptions>(command);
    const result = await runPlatformCommand(
      platformOptions,
      globalOptions.timeout,
      ({ client, signal }) =>
        listProjectServersOperation.execute(
          { project: resolveCloudProjectArgs(platformOptions).project },
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

      servers
      .command("create")
      .alias("add")
      .description("Create a saved MCP server")
      .option("--project <id-or-name>", "Project name or ID")
      .requiredOption("--body <json>", "Server JSON body").action(async (options: PlatformOptions & { body: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const platformOptions = platformOptionsOf<PlatformOptions>(command);
    const project = requireProject(command, platformOptions);
    const result = await runPlatformCommand(
      platformOptions,
      globalOptions.timeout,
      ({ client, signal }) =>
        createProjectServerOperation.execute(
          { project, body: parseBody(options.body) as never },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

      servers
      .command("get")
      .description("Get one saved MCP server")
      .option("--project <id-or-name>", "Project name or ID")
      .requiredOption("--server <id>", "Server ID").action(async (options: PlatformOptions & { server: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const platformOptions = platformOptionsOf<PlatformOptions>(command);
    const project = requireProject(command, platformOptions);
    const result = await runPlatformCommand(
      platformOptions,
      globalOptions.timeout,
      ({ client, signal }) =>
        getProjectServerOperation.execute(
          { project, serverId: options.server },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

      servers
      .command("update")
      .description("Update one saved MCP server")
      .option("--project <id-or-name>", "Project name or ID")
      .requiredOption("--server <id>", "Server ID")
      .requiredOption("--body <json>", "Patch JSON body").action(
    async (
      options: PlatformOptions & { server: string; body: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const platformOptions = platformOptionsOf<PlatformOptions>(command);
      const project = requireProject(command, platformOptions);
      const result = await runPlatformCommand(
        platformOptions,
        globalOptions.timeout,
        ({ client, signal }) =>
          updateProjectServerOperation.execute(
            {
              project,
              serverId: options.server,
              body: parseBody(options.body),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

      servers
      .command("delete")
      .alias("remove")
      .description("Delete one saved MCP server")
      .option("--project <id-or-name>", "Project name or ID")
      .requiredOption("--server <id>", "Server ID").action(async (options: PlatformOptions & { server: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const platformOptions = platformOptionsOf<PlatformOptions>(command);
    const project = requireProject(command, platformOptions);
    const result = await runPlatformCommand(
      platformOptions,
      globalOptions.timeout,
      ({ client, signal }) =>
        deleteProjectServerOperation.execute(
          { project, serverId: options.server },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

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
      .option("--no-wait", "Return as soon as the request is created").action(
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
      const platformOptions = platformOptionsOf<PlatformOptions>(command);

      // Parsed at the keyboard, like every sibling command here. Commander
      // hands back whatever was typed, so without this `--url " "` and
      // `--url file:///etc/passwd` travel all the way to the API to be
      // rejected there — a slower, vaguer error for a mistake visible now.
      const input = connectProjectServerOperation.inputSchema.parse({
        url: options.url,
        // NOT `options.project` — the `servers` group declares `--project` too
        // and therefore consumes it, so the subcommand's own copy is always
        // undefined and this command quietly connected to the default project
        // instead of the one that was named.
        project: resolveCloudProjectArgs(platformOptions).project,
        serverId: options.server,
        name: options.name,
        reauthorize: options.reauthorize,
      });

      const created = await runPlatformCommand(
        platformOptions,
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
        process.stderr.write(
          describeHandoffAudience(
            await resolveHandoffAudience(platformOptions, globalOptions.timeout)
          )
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
            `Not waiting. Follow it with:\n  mcpjam cloud projects servers connect-status --request ${created.connectionRequestId}\n` +
              `Or stop it with:\n  mcpjam cloud projects servers connect-cancel --request ${created.connectionRequestId}\n`
          );
        }
        writeResult(created, globalOptions.format);
        return;
      }

      const settled = await pollConnection(
        platformOptions,
        globalOptions.timeout,
        created.connectionRequestId,
        created.expiresAt
      );
      // An interrupt during the first request leaves no fresher status than the
      // one the create call returned, so report that rather than nothing.
      const latest = settled.result ?? created;
      writeResult(latest, globalOptions.format);
      if (settled.gaveUp) {
        // A script must be able to tell "it finished" from "I stopped
        // watching". Returning the last poll silently made those identical.
        process.stderr.write(
          `Stopped waiting; the request is still ${latest.status} and continues in the cloud.\n` +
            `  mcpjam cloud projects servers connect-status --request ${created.connectionRequestId}\n` +
            `  mcpjam cloud projects servers connect-cancel --request ${created.connectionRequestId}\n`
        );
        process.exitCode = 1;
      }
    }
  );

      servers
      .command("connect-status")
      .description("Check a connection request started by `server connect`")
      .requiredOption("--request <id>", "Connection request id (scr_…)").action(
    async (options: PlatformOptions & { request: string }, command) => {
      const globalOptions = getGlobalOptions(command);
      const input = getProjectServerConnectionStatusOperation.inputSchema.parse({
        connectionRequestId: options.request,
      });
      const payload = await runPlatformCommand(
        platformOptionsOf<PlatformOptions>(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          getProjectServerConnectionStatusOperation.execute(input, {
            client,
            signal,
          }),
        { cloudScope: { kind: "account" }, quiet: globalOptions.quiet }
      );
      writeResult(payload, globalOptions.format);
    }
  );

      servers
      .command("connect-cancel")
      .description("Cancel a pending connection request started by `server connect`")
      .requiredOption("--request <id>", "Connection request id (scr_…)").action(
    async (options: PlatformOptions & { request: string }, command) => {
      const globalOptions = getGlobalOptions(command);
      const input = cancelProjectServerConnectionOperation.inputSchema.parse({
        connectionRequestId: options.request,
      });
      const payload = await runPlatformCommand(
        platformOptionsOf<PlatformOptions>(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          cancelProjectServerConnectionOperation.execute(input, {
            client,
            signal,
          }),
        { cloudScope: { kind: "account" }, quiet: globalOptions.quiet }
      );
      writeResult(payload, globalOptions.format);
    }
  );

      projects
      .command("status")
      .description(
        "Health-check every server in a project (hosted doctor per server)"
      )
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      ).action(async (_options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const platformOptions = platformOptionsOf<PlatformOptions>(command);
    const payload = await runPlatformCommand(
      platformOptions,
      globalOptions.timeout,
      ({ client, signal }) =>
        showServersOperation.execute(
          { project: resolveCloudProjectArgs(platformOptions).project },
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
  /**
   * Undefined only when Ctrl-C landed during the very first status request, so
   * no poll ever returned. The caller has the create response and prints that
   * instead — there is nothing newer to report, and inventing a status would be
   * worse than saying what we last knew.
   */
  result:
    | Awaited<
        ReturnType<typeof getProjectServerConnectionStatusOperation.execute>
      >
    | undefined;
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
  /** The other half of the same promise. Waking the sleep is no help when the
   * interrupt lands while a status request is in flight: the flag is not read
   * again until that request resolves, so the terminal stays hung for up to the
   * request timeout after the user asked for it back. */
  const interruptController = new AbortController();
  /** The last status we actually received, so an interrupt mid-request can
   * still report something true rather than failing the command. */
  let lastResult:
    | Awaited<
        ReturnType<typeof getProjectServerConnectionStatusOperation.execute>
      >
    | undefined;
  const onInterrupt = () => {
    interrupted = true;
    process.stderr.write(
      "\nStopped watching. The request continues in the cloud — open the link above to finish it.\n"
    );
    wakeSleep?.();
    interruptController.abort(new Error("Interrupted by the user."));
  };
  // Registered only for the duration of the wait, and `once`, so a second
  // Ctrl-C still terminates the process the way a user expects.
  process.once("SIGINT", onInterrupt);

  try {
    for (;;) {
      // Already merged by the caller — this helper receives resolved options
      // rather than a Commander command.
      let current: Awaited<
        ReturnType<typeof getProjectServerConnectionStatusOperation.execute>
      >;
      try {
        current = await runPlatformCommand(
          options,
          timeoutMs,
          ({ client, signal }) =>
            getProjectServerConnectionStatusOperation.execute(
              { connectionRequestId },
              { client, signal }
            ),
          { externalSignal: interruptController.signal, announce: false }
        );
      } catch (error) {
        // OUR abort, not a failure: the user asked to stop and we cancelled the
        // request to make that immediate. Any other error is still the caller's
        // to see.
        if (!interrupted) throw error;
        return { result: lastResult, gaveUp: true };
      }
      lastResult = current;

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
