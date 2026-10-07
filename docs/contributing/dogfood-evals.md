# Dogfooding evals on our own MCP server

We ship an MCP server: the Cloudflare Worker in `mcp/`, serving
`mcp.mcpjam.com`. This is how we evaluate it with our own product, so that the
eval surfaces a customer uses are surfaces we use first.

## Two suite files, one set of questions

`.mcpjam/evals/` holds two:

| File | Targets | Job |
|---|---|---|
| `mcpjam-mcp.yaml` | `mcpjam-mcp-staging` | the promotion gate, evaluating the candidate before it ships |
| `mcpjam-mcp-production.yaml` | `mcpjam-mcp` | the nightly monitor, saying whether what is live drifted |

**Edit cases only in `mcpjam-mcp.yaml`.** `dogfood-suite-drift.test.ts` fails if
the two files' `cases:` blocks differ by a byte, so the production copy cannot
quietly start measuring something else. Everything above `cases:` is allowed to
differ, and must: identity, target, prose.

**Why not one file retargeted per run.** A file-owned suite always carries an
environment, and `eval run --server` against one is refused outright with
`ENVIRONMENT_SERVERS_NOT_OVERRIDABLE`. That refusal is right rather than
inconvenient: a suite's run history is only comparable within one target, so one
suite spanning two servers would corrupt every baseline comparison.

**`suite.id` is the ownership token and the two are not interchangeable.** Each
claims the hosted suite already bound to its server. Swap them and a file points
at a suite bound to the other environment, so the run goes to the wrong server
and still reports green. Need a fresh suite? Mint a new id rather than reuse one.

Running either file syncs it into its hosted suite, which is **CI-owned**: a
hand edit in the app comes back as

```
CI_OWNED_SUITE_READ_ONLY — This suite is managed by CI. Edit the test file in
your repository and run it again, or duplicate the suite to get an editable copy.
```

So there is one copy of the truth. To change a case, edit the YAML and merge.

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

- **Staging needs three things that are easy to forget.** Its worker must point
  at the same AuthKit tenant the staging backend uses, that tenant must have
  `https://mcp-staging.mcpjam.com/mcp` registered as an MCP resource indicator,
  and `staging.mcpjam.com/api/v1/*` must stay bypassed in Cloudflare Access so
  the worker can reach the platform API. Miss the last one and every tool call
  fails with `INTERNAL_ERROR: The MCPJam API returned a non-JSON response
  (200)`, which is Access's login page arriving where JSON was expected.
- **Check which server a run actually used.** `eval run --format json` reports
  `launch.targets[].servers`. A file pointed at a suite bound to the other
  environment still passes — against the wrong server. A green run on the wrong
  target is worse than a red one.
- **Re-running after an infrastructure change needs a fresh idempotency key.**
  `--notes` is excluded from the key, so an unchanged file and knobs returns the
  run it already started and you read a stale verdict believing it is new. Pass
  `--idempotency-key <unique>`; the workflow derives one per run attempt.
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
