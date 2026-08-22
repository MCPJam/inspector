import { Option, type Command } from "commander";

/**
 * Add a required option whose help shows only `visibleFlags`, plus a hidden
 * long-flag alias that sets the same value.
 *
 * Commander stores two long flags as short+long internally (the first long
 * flag occupies the "short" slot). Help prints `option.flags` verbatim, so
 * this rewrites that string to the canonical spelling after construction.
 * Both spellings still parse. `attributeName()` comes from the long flag —
 * put the canonical name second so `--server <name>` yields `options.server`.
 */
export function addRequiredOptionWithHiddenAlias(
  command: Command,
  visibleFlags: string,
  hiddenLongFlag: string,
  description: string
): Command {
  const option = new Option(
    `${hiddenLongFlag}, ${visibleFlags}`,
    description
  );
  option.flags = visibleFlags;
  option.makeOptionMandatory();
  return command.addOption(option);
}
