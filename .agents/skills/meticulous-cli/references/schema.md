# meticulous schema

```bash
meticulous schema [command..]
```

**Purpose:** Output the CLI command schema as JSON — designed for agent and programmatic use. Returns the structure of available commands (names, descriptions, subcommands, and options) without executing anything.

## Options

| Option    | Type                  | Description                                                         |
| --------- | --------------------- | ------------------------------------------------------------------- |
| `command` | positional (variadic) | Zero or more command path segments to drill into a specific command |

## Output Format

Without arguments, outputs a JSON array of all top-level command objects:

```json
[
  { "command": "auth", "describe": "Authentication commands", "subcommands": [...] },
  { "command": "ci",   "describe": "CI/CD commands",          "subcommands": [...] },
  ...
]
```

When targeting a specific leaf command (no subcommands), the full option schema is included:

```json
{
  "command": "simulate",
  "describe": "Replay a recorded session",
  "options": {
    "sessionId": { "type": "string", "required": true },
    "appUrl":    { "type": "string" },
    "headless":  { "type": "boolean", "default": false },
    ...
  }
}
```

## Examples

```bash
# List all top-level commands (structure only, no options)
meticulous schema

# Show the full option schema for a specific command
meticulous schema simulate
meticulous schema download replay
meticulous schema ci run-with-tunnel

# Show subcommands for a command group
meticulous schema ci
meticulous schema auth
```

## Use in Agent Workflows

The `schema` command is the recommended way for an agent to discover what commands exist and what options they accept before constructing a `meticulous` invocation:

1. Run `meticulous schema` to get the command tree.
2. Run `meticulous schema <command>` to get the full option list for the target command.
3. Construct the command with the required options.
4. On commands that support it (e.g. run-triggering / upload commands), optionally add `--dryRun` to verify the constructed invocation before executing it.
