import type { Command } from "commander";

/** Commander's own unknown-command error: the message, the "Did you mean"
 * suggestion and the `commander.unknownCommand` code. Not in its typings. */
type CommandWithUnknownCommand = Command & { unknownCommand(): never };

/**
 * Make `<group> <typo> --help` fail the way `<group> <typo>` does.
 *
 * Commander dispatches only when the first operand names a subcommand, and it
 * checks for `--help` before it reports an unknown one, so `cloud evalz --help`
 * printed the `cloud` help and exited 0. An agent reads that as "the command
 * exists"; it now gets the same usage error, suggestion and exit 2 as the
 * same line without `--help`.
 *
 * `beforeAllHelp` fires on the root before any help is written, so one
 * listener covers every group. The guard applies only to a command with
 * subcommands and no positional arguments of its own, where a leading operand
 * can only be a subcommand name. By the time help runs, Commander has already
 * consumed option values and everything after `--`, so `args[0]` is an operand
 * only when it does not start with `-`.
 */
export function installUnknownSubcommandHelpGuard(program: Command): void {
  program.on("beforeAllHelp", ({ command }: { command: Command }) => {
    const [first] = command.args;
    if (
      first === undefined ||
      first.startsWith("-") ||
      // `mcpjam help <name>` reaches here with the implicit help command as
      // the operand; it is not in `commands`.
      first === "help" ||
      command.commands.length === 0 ||
      command.registeredArguments.length > 0 ||
      command.commands.some(
        (sub) => sub.name() === first || sub.aliases().includes(first),
      )
    ) {
      return;
    }
    (command as CommandWithUnknownCommand).unknownCommand();
  });
}
