---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Let operators declare safe-to-execute primitives, so result-shape checks can run at all.

A family of requirements is only observable on a result the server produces by
DOING something. `tools/call` and `prompts/get` results have shapes no listing
can show, and a tool's declared `outputSchema` binds a value that exists only
once the tool runs. A default conformance run cannot reach any of it: nothing in
a tool's advertised metadata says whether calling it charges a card or deletes a
row, so a run that guessed would eventually be an outage.

`inputRequiredProbe` and `logProbe` already solved this for two specific checks
by making the operator name the tool. `fixtures` generalizes that pattern:

    { "toolCalls":   [{ "toolName": "weather", "arguments": { "city": "Lisbon" } }],
      "promptGets":  [{ "promptName": "greet",  "arguments": { "name": "Ada" } }] }

CLI: `--fixture-tool <name>` / `--fixture-prompt <name>` for the common
no-argument case, `--fixtures-file <path>` when arguments are needed (arguments
are arbitrary JSON, and a flag syntax for them would be a parser nobody asked
for). Suite config files accept a `fixtures` block per run. A malformed file is
a usage error rather than a silent empty set — a fixture set that vanished would
turn the gated checks into skips, which an operator reads as "my server does not
support this".

Two things this unlocks:

- `modern-tool-output-schema-conformant` asserts the MUST that "if an output
  schema is provided, servers MUST provide structured results that conform to
  this schema". Judged with the same dialect-aware validator the MCP client uses
  for tool inputs, so a tool declaring draft-07 (what `zod-to-json-schema`
  emits by default) is graded under draft-07 rather than rejected. An `isError:
  true` result does not bind the schema — the spec's own example of one carries
  no `structuredContent` — so it is reported, never failed.
- `wire-schema-valid` finally sees `CallToolResult` and `GetPromptResult`.
  Without fixtures those shapes never appear on the wire during a run, so the
  schema check had never once looked at them.

The default is unchanged and stays that way: with no fixtures, no tool is
called, and the gated check reports a skip naming exactly what it needs.
