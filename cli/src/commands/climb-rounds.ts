/**
 * `mcpjam cloud climbs rounds` and `mcpjam cloud climbs stop`: submit a saved
 * server as a round, read or wait for its result, overrule it, and stop the
 * climb.
 *
 *   mcpjam cloud climbs rounds submit --climb <id> --server "docs (mock)" --wait
 *   mcpjam cloud climbs rounds get --climb <id> --round 2
 *   mcpjam cloud climbs rounds decide --climb <id> --round 2 --decision kept --reason "..."
 *   mcpjam cloud climbs stop --climb <id>
 */
import type { Command } from "commander";
import {
  confirmClimbOperation,
  setClimbRoundDecisionOperation,
  stopClimbOperation,
  submitClimbRoundOperation,
  getClimbRoundOperation,
  suitePermalink,
  type ConfirmClimbInput,
  type SubmitClimbRoundInput,
} from "@mcpjam/sdk/platform";
import { usageError } from "../lib/output.js";
import { WAIT_FLAG, WAIT_SECONDS_DEFAULT, WAIT_SECONDS_FLAG, waitForConfirmation, waitForRound } from "../lib/climb-command.js";
import {
  addProjectOption,
  bindOperation,
  parseRequiredIntegerOption,
  parseIntegerOption,
  type PlatformOptions,
} from "../lib/platform-command.js";

type Wait = { wait?: boolean; waitSeconds?: string };
type RoundOptions = PlatformOptions & Wait & { project?: string; climb: string; round: string };
type SubmitInput = SubmitClimbRoundInput & { wait?: boolean; waitSeconds?: number };
type ConfirmInput = ConfirmClimbInput & { wait?: boolean; waitSeconds?: number };

function decisionOf(value: string): "kept" | "reverted" {
  if (value === "kept" || value === "reverted") return value;
  throw usageError("--decision must be kept or reverted");
}

const waitSeconds = (options: Wait) => parseIntegerOption(options.waitSeconds, "--wait-seconds", { min: 1 });

export function registerClimbRoundCommands(climbs: Command): void {
  const rounds = climbs.command("rounds").description("Submit a saved server as a round of a climb, read its result, or overrule it.");

  bindOperation(
    addProjectOption(
      rounds
        .command("submit")
        .description(
          "Submit a saved server (usually a mock) as the next round: it runs the steering and validation cases in every environment. THIS LAUNCHES PAID RUNS",
        )
        .requiredOption("--climb <id>", "The climb's ID")
        .requiredOption("--server <id-or-name>", "The saved server to measure")
        .option("--server-version <v>", "The mock version to run (default: its head now)")
        .option("--idempotency-key <key>", "Retry handle: a repeat with the same key returns the same round")
        .option(WAIT_FLAG, "Wait for the round to settle, then print it")
        .option(WAIT_SECONDS_FLAG, `How long --wait may take (default ${WAIT_SECONDS_DEFAULT})`),
    ),
    {
      name: submitClimbRoundOperation.name,
      permalink: suitePermalink,
      execute: async (input: SubmitInput, context) => {
        const { wait, waitSeconds: seconds, ...submit } = input;
        const submitted = await submitClimbRoundOperation.execute(submit, context);
        if (!wait) return submitted;
        return waitForRound({ climb: input.climb, round: submitted.roundNumber, project: input.project }, { wait, waitSeconds: seconds }, context);
      },
    },
    (options: PlatformOptions & Wait & { project?: string; climb: string; server: string; serverVersion?: string; idempotencyKey?: string }) => ({
      project: options.project,
      climb: options.climb,
      server: options.server,
      serverVersion: options.serverVersion,
      idempotencyKey: options.idempotencyKey,
      wait: options.wait,
      waitSeconds: waitSeconds(options),
    }),
  );

  bindOperation(
    addProjectOption(
      rounds
        .command("get")
        .description("Read a round: its verdict and why, who submitted it, and each environment's numbers against the noise")
        .requiredOption("--climb <id>", "The climb's ID")
        .requiredOption("--round <n>", "The round's number")
        .option(WAIT_FLAG, "Wait for the round to settle")
        .option(WAIT_SECONDS_FLAG, `How long --wait may take (default ${WAIT_SECONDS_DEFAULT})`),
    ),
    {
      name: getClimbRoundOperation.name,
      permalink: getClimbRoundOperation.permalink,
      execute: (input: { project?: string; climb: string; round: number; wait?: boolean; waitSeconds?: number }, context) =>
        waitForRound(
          { climb: input.climb, round: input.round, project: input.project },
          { wait: input.wait, waitSeconds: input.waitSeconds },
          context,
        ),
    },
    (options: RoundOptions) => ({
      project: options.project,
      climb: options.climb,
      round: parseRequiredIntegerOption(options.round, "--round", { min: 1 }),
      wait: options.wait,
      waitSeconds: waitSeconds(options),
    }),
  );

  bindOperation(
    addProjectOption(
      rounds
        .command("decide")
        .description("Overrule a settled round, with a reason that is recorded with your name")
        .requiredOption("--climb <id>", "The climb's ID")
        .requiredOption("--round <n>", "The round's number")
        .requiredOption("--decision <kept|reverted>", "What the round should stand as")
        .requiredOption("--reason <text>", "Why you are overruling the rule (500 characters at most)"),
    ),
    setClimbRoundDecisionOperation,
    (options: PlatformOptions & { project?: string; climb: string; round: string; decision: string; reason: string }) => ({
      project: options.project,
      climb: options.climb,
      round: parseRequiredIntegerOption(options.round, "--round", { min: 1 }),
      decision: decisionOf(options.decision),
      reason: options.reason,
    }),
  );

  bindOperation(
    addProjectOption(
      climbs
        .command("confirm")
        .description(
          "Run the one-time confirmation of a stopped climb on the cases no round ran, and print the difference with its 95% interval. THIS LAUNCHES PAID RUNS",
        )
        .requiredOption("--climb <id>", "The climb's ID")
        .option("--dry-run", "Print what the confirmation would cost and start nothing")
        .option(WAIT_FLAG, "Wait for the confirmation to settle (default: return once it has launched)")
        .option(WAIT_SECONDS_FLAG, `How long --wait may take (default ${WAIT_SECONDS_DEFAULT})`),
    ),
    {
      name: confirmClimbOperation.name,
      permalink: suitePermalink,
      execute: (input: ConfirmInput, context) => waitForConfirmation(input, context),
    },
    (options: PlatformOptions & Wait & { project?: string; climb: string; dryRun?: boolean }) => ({
      project: options.project,
      climb: options.climb,
      dryRun: options.dryRun,
      wait: options.wait,
      waitSeconds: waitSeconds(options),
    }),
  );

  bindOperation(
    addProjectOption(
      climbs
        .command("stop")
        .description("Stop a climb for good and print where it ended and the rounds that stand as kept")
        .requiredOption("--climb <id>", "The climb's ID"),
    ),
    stopClimbOperation,
    (options: PlatformOptions & { project?: string; climb: string }) => ({ project: options.project, climb: options.climb }),
  );
}
