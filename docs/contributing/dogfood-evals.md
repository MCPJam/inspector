# Dogfooding evals on our own MCP server

We ship an MCP server: the Cloudflare Worker in `mcp/`, serving
`mcp.mcpjam.com`. This is how we evaluate it with our own product, so that the
eval surfaces a customer uses are surfaces we use first.

## The suite lives in this repository

`.mcpjam/evals/mcpjam-mcp.yaml` is the suite. It is the only place the cases
are authored.

Running it syncs the file into a hosted suite named **mcpjam-mcp dogfood**, in
the project **MCPJam MCP dogfood**. That hosted suite is **CI-owned**: the
file's `suite.id` claims it, and the app refuses to edit it. A hand edit comes
back as

```
CI_OWNED_SUITE_READ_ONLY — This suite is managed by CI. Edit the test file in
your repository and run it again, or duplicate the suite to get an editable
copy.
```

So there is one copy of the truth. To change a case, edit the YAML and merge;
the next run carries it. To experiment without merging, duplicate the suite in
the app and edit the copy.

`suite.id` is the ownership token. Change it and the file no longer owns the
suite it created — it will try to claim a suite that is not its own and be
refused. Treat that line as permanent.

## Running it by hand

Needs an MCPJam API key from Settings → API keys, in the organization that owns
the project.

```sh
export MCPJAM_API_KEY=sk_…

# Validate without spending anything. Add --project and it also resolves the
# target server and every tool name the cases mention.
npx -y @mcpjam/cli@5.10.3 cloud eval validate \
  --file .mcpjam/evals/mcpjam-mcp.yaml \
  --project "MCPJam MCP dogfood"

# Sync the file and run it. This spends credits.
npx -y @mcpjam/cli@5.10.3 cloud eval run \
  --file .mcpjam/evals/mcpjam-mcp.yaml \
  --project "MCPJam MCP dogfood" \
  --wait --format json --out eval-report.json
```

Add `--case <id> --iterations 1` to run one case for a few cents, which is the
right way to check a change to the file itself.

Do not read the exit code through a pipe. `eval run --wait` owns a six-code
contract where `1` is a measured eval failure and `4`/`5` are infrastructure
and no-verdict, and `… | tail` reports `tail`'s status instead.

## What the cases are, and what they are not

Ten cases, all **read-only**, so a run is safe against any deployment. They
cover identity, projects, servers, eval reads, capabilities, and the server's
own glossary, plus two negative cases where not acting is the correct
behaviour.

Two deliberate choices, both written into the file:

- **The judge is off.** A suite file with no `judge` block inherits whatever
  the hosted suite has, so the file says `enabled: false` out loud rather than
  quietly paying for grading. Turning it on is a later, deliberate change.
- **Two iterations.** One cannot tell a flaky case from a broken one. The flat
  tool catalog is roughly 114k input tokens per iteration, so ten cases times
  two is already ~2.3M tokens a run. Cost is linear in both numbers.

## Things that will trip you up

- **It targets production.** `mcp.mcpjam.com`, because that is the server this
  project holds a consented OAuth connection for. Staging would be the better
  target — a pre-deploy gate beats a post-deploy alarm — but the staging worker
  trusts a different AuthKit tenant than the staging API, so nothing can hold a
  working credential for it yet. When that is fixed it is a one-line change.
- **Read a negative case's failure before believing it.** On a client with
  progressive tool discovery, the catalog meta-tools (`search_mcp_tools`,
  `load_mcp_tools`) still count as tool calls, so a negative case can fail for
  reaching the catalog rather than for acting. Open the trace.
- **`firstToolWas` is avoided on purpose.** The same progressive discovery
  means the first call is often a meta-tool, so the assertion can never hold.
  Use `toolCalledAtLeastOnce`.
- **Report it as a matrix, never as one number.** Pass rate depends heavily on
  whether the client serves a flat catalog or progressive discovery. One
  headline figure hides which of the two you measured.
- **`cloud eval export` cannot round-trip a generated suite.** A case bound to
  a scenario has no field in the suite-file format, and cases the platform
  generates are scenario-bound, so the file path is closed to exactly those
  suites. That is why this file was authored by hand rather than exported from
  the older 109-case promptset.
