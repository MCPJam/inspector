/**
 * Parse Commander help listings. Commander 14 can emit several command
 * groups (`Local MCP testing:`, `MCPJam Cloud:`, …) instead of a single
 * `Commands:` block; collect names from every indented command row.
 */
export function parseHelpCommandNames(help: string): string[] {
  const names: string[] = [];
  // Positional-argument rows (`Arguments:`) are indented like command rows
  // but are not commands.
  let inArguments = false;
  for (const line of help.split("\n")) {
    if (/^\S.*:$/.test(line)) {
      inArguments = line === "Arguments:";
      continue;
    }
    if (inArguments) continue;
    // Arguments may be optional (`[name]`) or required (`<file>`).
    const match = line.match(
      /^  ([a-z][\w|-]*)(?: \[options\])?(?: (?:\[[^\]]+\]|<[^>]+>))*\s{2,}/
    );
    if (!match) {
      continue;
    }
    const name = match[1].split("|")[0];
    if (name !== "help") {
      names.push(name);
    }
  }
  return names;
}
