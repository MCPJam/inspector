---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

`client` selects an eval target, everywhere `host` did

**One object, two names, from a rename that stopped half way.** `Client` is the
product noun — the v1 API registers `/clients` canonically with `/hosts` as a
deprecated alias, and `list_clients` already ships. The eval LAUNCH surfaces
kept `host`, so an agent reads `client` on every CRUD call and then has to type
`host` to run the thing it just made.

Both spellings are now accepted and folded to one field:

- `run_eval_suite` takes `client` / `clients` beside `host` / `hosts`
- `run_eval_case` takes `client` beside `host`
- `update_eval_suite` takes `clients: [{ client, servers }]` beside `hosts`
- `compose` takes `compose.client` beside `compose.host`
- the CLI takes `--client` and `--compose-client` on `cloud eval run`,
  `cases run`, `update` and `create`

Passing both spellings of one selector is a **usage error**, not a precedence
rule — the call `mcpjam cloud clients` already makes for its own pair, and the
one `--repetitions` / `--iterations` makes. A precedence rule is invisible: a
half-migrated script naming two different clients would keep running, and pay
for whichever one won.

`--host` also disambiguates. It means a host-compat **catalog** id under
`mcpjam tools|resources|prompts|probe|compat` and a **saved project row** under
`cloud eval`, and neither was deprecated. The catalog sense keeps `--host`;
under `cloud eval` `--client` is canonical, and passing a catalog id
(`--host claude`) to a client selector now gets an error that says which
`--host` you reached for and names `--client`.

`hostStyle`, `/host-catalog` and `clientCapabilities`/`clientInfo` inside a
config are NOT renamed: the last two are the MCP protocol's client, whose name
is the spec's.
