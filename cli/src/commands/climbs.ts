/**
 * `mcpjam cloud climbs`: improve a saved server from an eval suite, one round
 * at a time.
 *
 *   mcpjam cloud climbs start --suite smoke --server docs --round-limit 3 \
 *     --credit-limit 400 --wait
 *   mcpjam cloud climbs get --climb <id>
 *   mcpjam cloud climbs update --climb <id> --measure tokens --target-percent 5
 *   mcpjam cloud climbs list --suite smoke
 *
 * `start --wait` returns once the baseline has settled and the climb is ready,
 * or after `--wait-seconds`; without it the command returns as soon as the
 * baseline's runs have launched.
 */
import type { Command } from "commander";
import {
  getClimbOperation,
  listClimbsOperation,
  startClimbOperation,
  suitePermalink,
  updateClimbOperation,
  type StartClimbInput,
} from "@mcpjam/sdk/platform";
import { registerClimbRoundCommands } from "./climb-rounds.js";
import { usageError } from "../lib/output.js";
import {
  WAIT_FLAG,
  WAIT_SECONDS_DEFAULT,
  WAIT_SECONDS_FLAG,
  parseListOption,
  parseNumberOption,
  waitForClimb,
} from "../lib/climb-command.js";
import {
  addProjectOption,
  bindOperation,
  parseIntegerOption,
  parseRequiredIntegerOption,
  type PlatformOptions,
} from "../lib/platform-command.js";

type ClimbOptions = PlatformOptions & { project?: string; climb: string };
type Wait = { wait?: boolean; waitSeconds?: string };
type StartInput = StartClimbInput & { wait?: boolean; waitSeconds?: number };

const MEASURES = ["pass_rate", "tokens", "cost", "tool_calls"] as const;

function measureOf(value: string | undefined) {
  if (value === undefined) return undefined;
  const measure = MEASURES.find((candidate) => candidate === value);
  if (!measure) throw usageError(`--measure must be one of ${MEASURES.join(", ")}`);
  return measure;
}

function pickerOf(value: string | undefined): "agent" | "person" | undefined {
  if (value === undefined) return undefined;
  if (value === "agent" || value === "person") return value;
  throw usageError("--picker must be agent or person");
}

const waitSeconds = (options: Wait) => parseIntegerOption(options.waitSeconds, "--wait-seconds", { min: 1 });

export function registerClimbsCommands(cloud: Command): void {
  const climbs = cloud
    .command("climbs")
    .description("Improve a saved server from an eval suite, one round at a time, on mock servers.");

  bindOperation(
    addProjectOption(
      climbs
        .command("start")
        .description(
          "Start a climb and launch its baseline: two run groups through a mock with no changes, in each environment. THIS LAUNCHES PAID RUNS",
        )
        .requiredOption("--suite <id-or-name>", "The eval suite to climb")
        .requiredOption("--server <id-or-name>", "The saved server to improve")
        .requiredOption("--round-limit <n>", "The most rounds the climb may start (1 to 100)")
        .requiredOption("--credit-limit <n>", "The most credits the climb may commit, checked on estimates")
        .option("--environments <list>", "The suite's environments to climb in, comma-separated (default: all, up to 10)")
        .option("--picker <who>", "Who picks each change: agent (default) or person")
        .option("--measure <measure>", `What to climb for: ${MEASURES.join(", ")} (default pass_rate)`)
        .option("--min-improvement-percent <n>", "The smallest move of tokens, cost or tool calls that counts (default 1)")
        .option("--target-percent <n>", "Stop when tokens, cost or tool calls are this percent lower than the baseline")
        .option("--steering-count <n>", "Cases in the steering group")
        .option("--validation-count <n>", "Cases in the validation group")
        .option("--confirmation-count <n>", "Cases in the confirmation group")
        .option("--steering <keys>", "Case keys for the steering group, comma-separated")
        .option("--validation <keys>", "Case keys for the validation group, comma-separated")
        .option("--confirmation <keys>", "Case keys for the confirmation group, comma-separated")
        .option("--seed <n>", "Seeds the random split of the cases")
        .option(WAIT_FLAG, "Wait for the baseline to settle, then print the climb")
        .option(WAIT_SECONDS_FLAG, `How long --wait may take (default ${WAIT_SECONDS_DEFAULT})`),
    ),
    {
      name: startClimbOperation.name,
      permalink: suitePermalink,
      execute: async (input: StartInput, context) => {
        const { wait, waitSeconds, ...start } = input;
        const started = await startClimbOperation.execute(start, context);
        return waitForClimb(started, { wait, waitSeconds, project: input.project }, context, (climb) => climb.state !== "baselining");
      },
    },
    (
      options: PlatformOptions &
        Wait & {
          project?: string;
          suite: string;
          server: string;
          roundLimit: string;
          creditLimit: string;
          environments?: string;
          picker?: string;
          measure?: string;
          minImprovementPercent?: string;
          targetPercent?: string;
          steeringCount?: string;
          validationCount?: string;
          confirmationCount?: string;
          steering?: string;
          validation?: string;
          confirmation?: string;
          seed?: string;
        },
    ) => {
      const sizes = {
        steering: parseIntegerOption(options.steeringCount, "--steering-count", { min: 0 }),
        validation: parseIntegerOption(options.validationCount, "--validation-count", { min: 0 }),
        confirmation: parseIntegerOption(options.confirmationCount, "--confirmation-count", { min: 0 }),
      };
      const lists = {
        steering: parseListOption(options.steering, "--steering"),
        validation: parseListOption(options.validation, "--validation"),
        confirmation: parseListOption(options.confirmation, "--confirmation"),
      };
      const given = <T extends object>(group: T) => Object.values(group).some((value) => value !== undefined);
      if (given(sizes) && given(lists)) {
        throw usageError("Give case counts (--steering-count and so on) or case keys (--steering and so on), not both.");
      }
      const clean = <T extends object>(group: T) =>
        Object.fromEntries(Object.entries(group).filter(([, value]) => value !== undefined));
      return {
        project: options.project,
        suite: options.suite,
        server: options.server,
        roundLimit: parseRequiredIntegerOption(options.roundLimit, "--round-limit", { min: 1, max: 100 }),
        creditLimit: parseNumberOption(options.creditLimit, "--credit-limit", { exclusiveMin: 0 }) as number,
        environments: parseListOption(options.environments, "--environments"),
        picker: pickerOf(options.picker),
        measure: measureOf(options.measure),
        minImprovementPercent: parseNumberOption(options.minImprovementPercent, "--min-improvement-percent", {
          min: 0.01,
          max: 100,
        }),
        targetPercent: parseNumberOption(options.targetPercent, "--target-percent", { exclusiveMin: 0, max: 99.99 }),
        groupSizes: given(sizes) ? clean(sizes) : undefined,
        groups: given(lists) ? clean(lists) : undefined,
        seed: parseIntegerOption(options.seed, "--seed"),
        wait: options.wait,
        waitSeconds: waitSeconds(options),
      };
    },
  );

  bindOperation(
    addProjectOption(
      climbs
        .command("update")
        .description("Change what a climb is for, its smallest improvement or target (until round 1 settles), or set cases aside for confirmation")
        .requiredOption("--climb <id>", "The climb's ID")
        .option("--measure <measure>", `What to climb for: ${MEASURES.join(", ")}`)
        .option("--min-improvement-percent <n>", "The smallest move of tokens, cost or tool calls that counts")
        .option("--target-percent <n>", "Stop when tokens, cost or tool calls are this percent lower than the baseline")
        .option("--clear-target", "Remove the target")
        .option("--move-to-confirmation <keys>", "Case keys to set aside as confirmation cases, comma-separated"),
    ),
    updateClimbOperation,
    (
      options: ClimbOptions & {
        measure?: string;
        minImprovementPercent?: string;
        targetPercent?: string;
        clearTarget?: boolean;
        moveToConfirmation?: string;
      },
    ) => {
      if (options.clearTarget && options.targetPercent !== undefined) {
        throw usageError("Give --target-percent or --clear-target, not both.");
      }
      return {
        project: options.project,
        climb: options.climb,
        measure: measureOf(options.measure),
        minImprovementPercent: parseNumberOption(options.minImprovementPercent, "--min-improvement-percent", {
          min: 0.01,
          max: 100,
        }),
        targetPercent: options.clearTarget
          ? null
          : parseNumberOption(options.targetPercent, "--target-percent", { exclusiveMin: 0, max: 99.99 }),
        moveToConfirmation: parseListOption(options.moveToConfirmation, "--move-to-confirmation"),
      };
    },
  );

  bindOperation(
    addProjectOption(
      climbs
        .command("get")
        .description("Read a climb: state, limits, the baseline's noise, every round and who submitted it, and the best server so far")
        .requiredOption("--climb <id>", "The climb's ID"),
    ),
    getClimbOperation,
    (options: ClimbOptions) => ({ project: options.project, climb: options.climb }),
  );

  bindOperation(
    addProjectOption(
      climbs
        .command("list")
        .description("List a project's climbs, newest first")
        .option("--suite <id-or-name>", "Only this suite's climbs")
        .option("--limit <n>", "How many to list"),
    ),
    listClimbsOperation,
    (options: PlatformOptions & { project?: string; suite?: string; limit?: string }) => ({
      project: options.project,
      suite: options.suite,
      limit: parseIntegerOption(options.limit, "--limit", { min: 1, max: 100 }),
    }),
  );

  registerClimbRoundCommands(climbs);
}
