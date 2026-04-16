import { Command } from "commander";
import { parsePositiveInteger } from "../lib/server-config";
import {
  setProcessExitCode,
  usageError,
  writeResult,
  type OutputFormat,
} from "../lib/output";
import { loadEvalsConfig } from "../lib/evals-config";
import { runEvals } from "../lib/evals-runner";
import { formatEvalsHuman, formatEvalsJUnit } from "../lib/evals-output";

type EvalsOutputFormat = OutputFormat | "junit-xml";

function parseEvalsFormat(command: Command): EvalsOutputFormat {
  const opts = command.optsWithGlobals() as { format?: string };
  const value = opts.format ?? "json";
  if (value === "json" || value === "human" || value === "junit-xml") {
    return value;
  }
  throw usageError(
    `Invalid output format "${value}". Use "json", "human", or "junit-xml".`,
  );
}

/**
 * Serialize an EvalSuiteResult for JSON output.
 * The result.tests is a Map, which JSON.stringify ignores, so convert it.
 */
function suiteResultToJson(result: import("@mcpjam/sdk").EvalSuiteResult): unknown {
  const tests: Record<string, unknown> = {};
  for (const [name, testResult] of result.tests) {
    tests[name] = testResult;
  }
  return {
    tests,
    aggregate: result.aggregate,
  };
}

export function registerEvalsCommands(program: Command): void {
  const evals = program
    .command("evals")
    .description("Run LLM eval suites against MCP servers");

  evals
    .command("run")
    .description("Run eval tests defined in a JSON config file")
    .requiredOption("--config <path>", "Path to evals JSON config file")
    .option(
      "--iterations <n>",
      "Override number of iterations per test",
      (value: string) => parsePositiveInteger(value, "Iterations"),
    )
    .option(
      "--concurrency <n>",
      "Override concurrency level",
      (value: string) => parsePositiveInteger(value, "Concurrency"),
    )
    .action(async (options, command) => {
      const format = parseEvalsFormat(command);
      const config = loadEvalsConfig(options.config);

      const result = await runEvals(config, {
        iterations: options.iterations,
        concurrency: options.concurrency,
      });

      switch (format) {
        case "json":
          writeResult(suiteResultToJson(result));
          break;
        case "human":
          process.stdout.write(formatEvalsHuman(result, config));
          break;
        case "junit-xml":
          process.stdout.write(
            formatEvalsJUnit(result, config.mcpjam?.suiteName ?? "Eval Suite"),
          );
          break;
      }

      if (result.aggregate.failures > 0) {
        setProcessExitCode(1);
      }
    });

  evals
    .command("validate")
    .description("Validate an evals config file without running tests")
    .requiredOption("--config <path>", "Path to evals JSON config file")
    .action(async (options, command) => {
      const format = parseEvalsFormat(command);

      try {
        const config = loadEvalsConfig(options.config);
        const summary = {
          valid: true,
          servers: Object.keys(config.servers).length,
          tests: config.tests.length,
          model: config.agent.model,
        };

        if (format === "human") {
          process.stdout.write(
            `Config valid: ${summary.servers} server(s), ${summary.tests} test(s), model ${summary.model}\n`,
          );
        } else {
          writeResult(summary);
        }
      } catch (error) {
        if (format === "human") {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`Validation failed: ${message}\n`);
        } else {
          writeResult({
            valid: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        setProcessExitCode(1);
      }
    });
}
