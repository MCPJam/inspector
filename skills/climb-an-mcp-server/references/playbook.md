# Playbook: what to change for what failed

Start from the failed runs behind a `climbFor` option, not from a list of ideas. Each entry in `whatCanChange` says what points at it.

| The failed runs say | Change | Notes |
|---|---|---|
| The model picked the wrong tool, or none (`selection`) | The tool's `description`: say when to use it and when not to, in the words the case's prompt uses | Descriptions are read by every client. Cheapest and safest first change. |
| The model called the right tool with wrong arguments (`arguments`) | The parameter's description (`params.<name>.description`) or the input schema | Hide a parameter only if it is never the caller's to set; `fixed` sends a value on every call. Hiding a required parameter without fixing it is refused. |
| The tool answered, the answer was not what the user wanted (`serverData`, `userValue`) | A tool result needs saved answers, which are not built yet. Change the description to set expectations, or the instructions | Say so rather than faking it. |
| Too many tokens, cost or tool calls with every case passing | Hide tools no case calls; shorten descriptions that do not change behavior | Climb for the measure, not pass rate. Check the round's pass rate did not move. |
| A case expects a tool the server does not list | Not a mock change. Tell the person the server lacks it | `missing_capability` in `climbFor`. |

## By part of the server

- **Tool descriptions and inputs.** Read by every client. First place to look.
- **Titles, output schemas, annotations, icons.** MCPJam's own client does not send them to the model, so a round that changes only these is refused when every environment runs it. Harness clients may read them: this is unconfirmed, so a climb that includes one can try.
- **Instructions.** Harness clients read them in the handshake. Whether MCPJam's client puts them in an eval's prompt is unconfirmed.
- **Prompts, resources, skills, apps.** Not built into mocks yet. Do not propose them as mock changes; a code round can try them.
- **Anything in the code.** A fix a mock cannot state (a missing tool, a tool's answer, a prompt or resource) is a code round: save a server that runs your branch and submit it. Make one change per branch.

## Before you write a change

Read the real value (`get_mock_server`, `realServer`). A mock states only what it changes: anything you leave out follows the real server. Do not copy a description whole to change one word of it; state the new description.
