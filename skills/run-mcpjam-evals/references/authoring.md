# Authoring suites and cases through the tools

For writing eval files in a repo, use `create-mcp-eval` (`@mcpjam/sdk` tests) or `mcpjam-eval-import` (converting an existing corpus). This is the other path: creating and editing suites that live in an MCPJam project, through the hosted tools.

## Creating a suite

`create_eval_suite` takes `project`, `name`, `description`, `servers`, `model`, `provider`, and one or more `cases`. A suite is runnable the moment it exists, so decide two things before you call it:

- **Which servers it runs against.** `servers` are the project's HTTP servers. If the suite should instead run against a pinned environment — resolved host config, closed server set, pinned plugin versions — attach one afterwards with `set_eval_suite_environments`, and note that it **replaces** whatever the suite had rather than adding to it.
- **Which model is the default.** Cases can override with their own `models`, but the suite default is what most of them will use.

## The shape of a case

Every case is an ordered `steps` array, and the step kind is what distinguishes them:

- **`prompt`** — a model turn. This is where non-determinism enters.
- **`toolCall`** — a deterministic tool call, no model involved.
- **`assert`** — the expectations, e.g. `toolCalledWith`, `widgetRendered`.

Alongside `steps`, a case carries `expectedOutput`, `iterations`, `isNegative`, `scenario`, `models`, `matchOptions`, and `checks`.

Two things worth getting right the first time:

- **`iterations` multiplies cost.** Every iteration is a fresh model call. It is the right tool for measuring a flaky tool-selection case, and the wrong one for a deterministic `toolCall`-only case, which will produce the same answer N times at N times the price.
- **`isNegative` inverts the meaning of success.** A negative case passes when the model does *not* call tools. Every suite should have at least one; without it a suite cannot distinguish "chose correctly" from "always calls something".

## Adding cases

- `create_eval_case` — one case.
- `create_eval_cases` — the bulk form, and the right one for converting a repo's test files or importing a suite. One call instead of a round trip per case.

`create_eval_cases` takes `duplicatePolicy` and `overrideReason`. Decide the policy deliberately: re-importing a corpus with the wrong one either silently doubles the suite or silently discards edits made since the last import.

## Editing

`update_eval_case` changes only the fields you pass — **except `steps`, which replaces the sequence wholesale.** There is no partial step edit. To change one step, read the case with `list_eval_cases`, modify the array, and send it back whole; sending only the changed step deletes the rest.

## Generating cases

`generate_eval_cases` AI-generates cases from the suite's server tools and persists them. It **spends the organization's credits**, and it connects the servers to discover their tools, so it is not a dry run in any sense.

- Confirm before calling it, the same as `run_eval_suite`.
- Pass `idempotencyKey` if the call might be retried — a transport error is not proof nothing was generated.
- `caseMix`, `caseModels`, and `varyUserStyles` shape the output. Generated cases are a starting point to review, not a suite to run and report on unread.

## Scheduling

`set_eval_suite_schedule` turns on automatic runs and sets `intervalMinutes`. Every scheduled run bills like a manual one — an aggressive interval on a large suite is a standing charge, so say the multiplication out loud before enabling it. Disabling preserves the stored interval and environment pin, so it is reversible.

## Before running what you just built

`get_eval_suite` returns the suite's fully resolved settings — execution config, hosts, match options, checks, and the resolved LLM-as-judge block (enabled, model, autoRun, threshold). Resolved is the point: it shows what a run will actually use after defaults and environment pins are applied, which is not always what was passed in.
