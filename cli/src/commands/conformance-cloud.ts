import type { Command } from "commander";
import {
  getConformanceCheckOperation,
  getConformanceReportOperation,
  getConformanceRunOperation,
  listConformanceRunsOperation,
  startConformanceRunOperation,
  type ConformanceRunScopedInput,
  type GetConformanceCheckInput,
  type GetConformanceReportInput,
  type ListConformanceRunsInput,
  type StartConformanceRunInput,
} from "@mcpjam/sdk/platform";
import {
  addProjectOption,
  bindOperation,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { parsePositiveInteger } from "../lib/server-config.js";

/**
 * Hosted conformance runs on a project's saved servers: start one, poll it,
 * page through its failures and read one check in full. Each command returns
 * at once; `run` hands back the run id and its Inspector link to poll with
 * `status`. The local `mcpjam conformance` commands grade what this machine
 * reaches instead, and record nothing in a project.
 */
interface RunOptions extends PlatformOptions {
  project?: string;
  server: string;
  suite?: Array<"protocol" | "apps" | "tasks">;
  protocolVersion?: string;
  settings?: "saved" | "none";
  idempotencyKey?: string;
}

interface RunsOptions extends PlatformOptions {
  project?: string;
  server?: string;
  limit?: number;
  cursor?: string;
}

interface RunScopedOptions extends PlatformOptions {
  project?: string;
  run: string;
  cursor?: string;
}

interface CheckOptions extends RunScopedOptions {
  check: string;
  suite?: "protocol" | "apps" | "tasks" | "oauth";
}

const collect = (value: string, previous: string[] = []) => [
  ...previous,
  value,
];

export function registerCloudConformanceCommands(cloud: Command): Command {
  const conformance = cloud
    .command("conformance")
    .description(
      "Hosted conformance runs on saved servers: start, poll, read failures",
    );

  const run = addProjectOption(
    conformance
      .command("run")
      .description(
        "Start a hosted run on a saved server with its saved conformance settings",
      )
      .requiredOption("--server <id-or-name>", "Saved server to check")
      .option(
        "--suite <suite>",
        "Suite to run: protocol, apps or tasks (repeatable; default all three)",
        collect,
      )
      .option("--protocol-version <version>", "Pin one MCP protocol version")
      .option(
        "--settings <mode>",
        "saved (default) runs the server's saved checks and tool inputs; none runs every check with no tool inputs",
      )
      .option("--idempotency-key <key>", "Replay guard for a retried start"),
  );
  bindOperation<RunOptions, StartConformanceRunInput>(
    run,
    startConformanceRunOperation,
    (options) => ({
      project: options.project,
      server: options.server,
      ...(options.suite ? { suites: options.suite } : {}),
      ...(options.protocolVersion
        ? { protocolVersion: options.protocolVersion }
        : {}),
      ...(options.settings ? { settings: options.settings } : {}),
      ...(options.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
    }),
  );

  const runs = addProjectOption(
    conformance
      .command("runs")
      .description("List hosted conformance runs, newest first")
      .option("--server <id-or-name>", "Narrow to one saved server")
      .option("--limit <n>", "Rows to return (1-100)", (value: string) =>
        parsePositiveInteger(value, "Limit"),
      )
      .option("--cursor <cursor>", "The nextCursor of the previous page"),
  );
  bindOperation<RunsOptions, ListConformanceRunsInput>(
    runs,
    listConformanceRunsOperation,
    (options) => ({
      project: options.project,
      ...(options.server ? { server: options.server } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.cursor ? { cursor: options.cursor } : {}),
    }),
  );

  const status = addProjectOption(
    conformance
      .command("status")
      .description("Read one hosted conformance run: status, outcome and score")
      .requiredOption("--run <id>", "Conformance run id"),
  );
  bindOperation<RunScopedOptions, ConformanceRunScopedInput>(
    status,
    getConformanceRunOperation,
    (options) => ({ project: options.project, run: options.run }),
  );

  const report = addProjectOption(
    conformance
      .command("report")
      .description("Page through a run's failing checks, 50 at a time")
      .requiredOption("--run <id>", "Conformance run id")
      .option("--cursor <cursor>", "The nextCursor of the previous page"),
  );
  bindOperation<RunScopedOptions, GetConformanceReportInput>(
    report,
    getConformanceReportOperation,
    (options) => ({
      project: options.project,
      run: options.run,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    }),
  );

  const check = addProjectOption(
    conformance
      .command("check")
      .description("Read one check of a run in full, with its stored evidence")
      .requiredOption("--run <id>", "Conformance run id")
      .requiredOption("--check <id>", "Check id, as `report` lists it")
      .option(
        "--suite <suite>",
        "The check's suite, when the same id is in two suites of the run",
      ),
  );
  bindOperation<CheckOptions, GetConformanceCheckInput>(
    check,
    getConformanceCheckOperation,
    (options) => ({
      project: options.project,
      run: options.run,
      check: options.check,
      ...(options.suite ? { suite: options.suite } : {}),
    }),
  );

  return conformance;
}
