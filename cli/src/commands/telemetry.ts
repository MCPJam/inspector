import { Command } from "commander";
import { writeResult, type OutputFormat } from "../lib/output.js";
import { getGlobalOptions } from "../lib/server-config.js";
import {
  formatTelemetryStatusHuman,
  getTelemetryStatus,
  setTelemetryEnabled,
  type TelemetryOptions,
} from "../lib/telemetry.js";

interface TelemetryCommandOptions {
  telemetry?: boolean;
}

export function registerTelemetryCommands(
  program: Command,
  telemetryOptions: TelemetryOptions = {},
): void {
  const telemetry = program
    .command("telemetry")
    .description("Inspect and configure anonymous CLI telemetry");

  telemetry
    .command("status")
    .description("Show the current telemetry status")
    .action((_options, command) => {
      writeTelemetryStatus(
        resolveTelemetryStatus(command, telemetryOptions),
        getGlobalOptions(command).format,
      );
    });

  telemetry
    .command("disable")
    .description("Disable anonymous CLI telemetry")
    .action((_options, command) => {
      setTelemetryEnabled(false, telemetryOptions);
      writeTelemetryStatus(
        resolveTelemetryStatus(command, telemetryOptions),
        getGlobalOptions(command).format,
      );
    });

  telemetry
    .command("enable")
    .description("Enable anonymous CLI telemetry")
    .action((_options, command) => {
      setTelemetryEnabled(true, telemetryOptions);
      writeTelemetryStatus(
        resolveTelemetryStatus(command, telemetryOptions),
        getGlobalOptions(command).format,
      );
    });
}

function resolveTelemetryStatus(
  command: Command,
  telemetryOptions: TelemetryOptions,
) {
  const options = command.optsWithGlobals() as TelemetryCommandOptions;
  return getTelemetryStatus({
    ...telemetryOptions,
    commandOptOut: options.telemetry === false,
  });
}

function writeTelemetryStatus(
  status: ReturnType<typeof getTelemetryStatus>,
  format: OutputFormat,
): void {
  if (format === "human") {
    process.stdout.write(formatTelemetryStatusHuman(status));
    return;
  }

  writeResult(
    {
      success: true,
      telemetry: status,
    },
    format,
  );
}
