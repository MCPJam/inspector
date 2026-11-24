---
name: climb-an-mcp-server
description: Improve an MCP server from an eval suite with MCPJam's climb tools, one measured change at a time, on mock servers or on a saved server that runs your code change, then hand the kept changes to the coding agent that edits the server's code and verify them on the real server. Use when connected to MCPJam's MCP server and asked to improve, tune or hill-climb a server, its tool descriptions or its token use, from an eval that already exists.
---

# climb-an-mcp-server

You have MCPJam's climb tools. A climb improves a saved server from an eval suite, one round at a time. Each round tries one change on a **mock**: a real MCP server MCPJam hosts in front of the server, which states only what you change and leaves everything else to the real server. A change to the server's code is a **code round**: you save a server that runs your branch and submit it. A stated rule keeps or reverts the change in every environment the suite runs in. At the end the kept changes come back as a prompt for whoever edits the server's code, and `verify_climb` checks they hold on the real server.

This skill is about running a climb. To write the eval first, use `create-mcp-eval` or `run-mcpjam-evals`.

## Reference map

| You are about to... | Read |
|---|---|
| Choose what to change for a failure | `references/playbook.md` |
| Read a round's result | `references/rounds.md` |

## What never to read

The climb splits the suite's cases three ways, and two groups are kept from you on purpose.

- **Validation cases** run in every round and can get your change reverted. You see their totals. Never open a validation run's transcript, and never look up which cases they are. If you steer by them, the result stops meaning anything.
- **Confirmation cases** run once, at the end, in `confirm_climb`. Never read their prompts in the suite or open their runs.

The tools never hand you either. Your sign-in could open them. Do not.

## The loop

```
start_climb -> get_climb (until ready) -> create_mock_server / update_mock_server
     -> submit_climb_round -> get_climb_round (waitSeconds) -> next round ...
     (a code change: save a server that runs your branch, then submit_climb_round with it)
     -> stop_climb -> confirm_climb -> apply the prompt -> verify_climb
```

**1. Start.** `start_climb` needs the suite, the saved server, `roundLimit` and `creditLimit`. There are no defaults: choose limits you can afford, because every run is paid and the climb refuses a round past either. It launches the baseline: the server twice through a mock with no changes, in each environment, and returns at once.

**2. Read the baseline.** Poll `get_climb` until `state` is `ready`. Read `suiteCheck` first: the noise per environment, the smallest change the suite can show, cases that passed in one baseline run and failed in the other (noise, not signal), environments with no room to improve, and tools no validation case covers. If `canShowChange` is false, do not climb yet: say what the check says and add iterations or cases.

**3. Choose what to climb for.** `climbFor` is one list. Each option names its measure (pass rate, tokens, cost or tool calls), a number counted on steering cases, and up to three failed runs with a reason and a link. Open a failed run before you choose: it is the evidence. Set it with `update_climb` before round 1 settles; after that it is fixed. A suite where every case passes cannot be climbed for pass rate: climb for tokens, cost or tool calls.

**4. Write the change.** `get_mock_server` returns `whatCanChange`: every place a mock can change, ranked, with the current value, which clients read it and the failed runs that point at it. Take the top entry whose clients include the ones your environments run. A change no client of the climb reads is refused before any run. Make **one change per round** so a result means one thing. Create the mock from the real server with `create_mock_server`, or save a new version with `update_mock_server` and the version you read.

**5. Submit and read.** `submit_climb_round` with the mock. For a code change, save a server that runs your branch and submit that saved server instead: any saved server of the project is a round's server. The climbed server keeps running its current code for the whole climb, because the baseline and the best so far are measured on it, so never change its code in place. Then `get_climb_round` with `waitSeconds` up to 50 and call it again while `settled` is false. The result is per environment, against the noise. See `references/rounds.md`.

**6. Repeat** until `get_climb` says the climb stopped (every steering case passes, the target was reached, or the round limit), or stop it yourself with `stop_climb`. A round that is refused names what is needed and what is left: do not work around a limit, report it.

**7. Stop, confirm, apply.** `stop_climb` returns the summary and the prompt. The summary labels steering and validation results as the cases that helped pick the result, and says what the climb established and what it did not. If the suite set cases aside, call `confirm_climb` once (use `dryRun` first for the cost): it reports the difference with a 95% interval, and when the interval includes zero the gain is within noise and you should say so and not recommend shipping it. Hand the prompt to the agent that edits the server's code. A kept code round shows in the prompt as the saved server it ran: keep that code by merging the branch it runs.

**8. Verify.** After the edits are committed and the server runs them, call `verify_climb` with the commit. It names each kept change as applied, missing or different, and starts no run unless asked. Then it runs the server beside a mock that puts the old values back and applies the same rule. When the kept change is code, a mock cannot put it back: it runs the server alone and sets its numbers beside the ones the climb recorded. Report whether the gain holds on the real server, both gains, and the baseline then and now. MCPJam records the commit you give it; it cannot check which code the server runs.

## Rules that save money and trust

- One change per round. Never batch.
- A kept code round makes its server the best so far. Leave that server's code as it is and run the next code change on another saved server: a later round on the same server would be measured against itself.
- If `suiteCheck` says an environment replays one decision (`replays_one_decision`), a change that steers the model can look like a sure win there. For a pass-rate climb, use an environment that samples.
- Never resubmit a reverted change hoping for a different result. A round measures noise too; `get_climb_round` shows how much.
- A round that is **not decided** is not a loss: read its reason (a lost run, a changed real server) and fix that, do not read it as a result.
- Overrule a round (`set_climb_round_decision`) only with a reason you would put your name to. It is recorded.
- Keep the climb's own limits. Do not start a second climb to get around the first one's.
