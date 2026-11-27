import type { AddHelpTextContext, Command } from "commander";
import { usageError, writeError, type OutputFormat } from "./output.js";

/**
 * Help Commander printed as an error. A command group run without a
 * subcommand (`mcpjam cloud`) writes its help through `writeErr` and throws
 * `commander.help`. `main` silences `writeErr` so usage errors come out as
 * structured JSON, which hid this help as well.
 */
export interface ErrorHelp {
  /** The full command, such as `mcpjam cloud`. */
  command: string;
  text: string;
}

export interface ErrorHelpRecorder {
  /**
   * The root command's `writeErr`. It drops Commander's other error text:
   * `main` reports those errors as JSON.
   */
  writeErr: (text: string) => void;
  /** The help Commander printed as an error in this run, if it did. */
  captured: () => ErrorHelp | undefined;
}

/**
 * Pass `writeErr` to the root's `configureOutput` before any subcommand is
 * added: a subcommand copies the root's output settings when it is created.
 */
export function recordErrorHelp(program: Command): ErrorHelpRecorder {
  let captured: ErrorHelp | undefined;
  // Commander emits this on the root for every command's help, just before
  // writing it.
  program.on("beforeAllHelp", (context: AddHelpTextContext) => {
    captured = context.error
      ? { command: commandPath(context.command), text: "" }
      : undefined;
  });
  return {
    writeErr: (text) => {
      if (captured) captured.text += text;
    },
    captured: () => captured,
  };
}

/** The help in human format; in JSON, a usage error that points at it. */
export function writeErrorHelp(help: ErrorHelp, format: OutputFormat): void {
  if (format === "human") {
    process.stderr.write(help.text);
    return;
  }
  writeError(
    usageError(
      `\`${help.command}\` needs a command. Run \`${help.command} --help\` to list them.`,
    ),
    format,
  );
}

function commandPath(command: Command): string {
  const names: string[] = [];
  for (
    let current: Command | null = command;
    current;
    current = current.parent
  ) {
    names.unshift(current.name());
  }
  return names.join(" ");
}
