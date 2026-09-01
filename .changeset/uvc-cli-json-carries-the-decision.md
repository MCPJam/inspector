---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

The CLI tells the same story in JSON as it does in prose, and leads with where the chain broke

**`--format json` was the one consumer that never got the decision.** `eval run --wait` built the run's decision summary, printed it as prose for a human, and then dropped it for the machine reader — the guard on the fetch was literally `format === "human"`. `eval compare` did the same: it assembled the compare side's summary, wrote it to stderr and onto the reporter artifact, and left it out of the JSON document. So the consumer that cannot ask a follow-up question was the only one told nothing but an exit code. Both now carry `decisionSummary` inside their existing stdout document — one parseable document still, the summary inside it rather than appended after it. `docs/cli/ci.mdx` claimed this was already true; it now carries a per-command table that is.

**`eval status` can page its diagnostics.** The command asked for 20 and said nothing about the rest, so a run with two hundred failures reported the first twenty and `complete: false` — a field a reader who does not know it exists cannot act on. `--diagnostics-limit` and `--diagnostics-cursor` walk them. The handler also stopped casting its input and started validating it, so `--diagnostics-limit 500` is a usage error against the schema's own 1..200 bound instead of a request that travels to the wire.

**The human summary now leads with where the chain broke.** Under the diagnostics headline, before any per-trial detail, a non-passing run gets one line: the earliest stage at which a readable trial stopped, why, and how many stopped there — "First break: Tool call — the call arguments did not match what the case expects (2 of 3 measured trials)". "First" means earliest in chain order, never "most common", so the count beside it is what says whether the run had one problem or several; the line names how many stages broke when they are spread, and how many chains could not be read at all, because otherwise the denominator quietly shrinks to the trials that happened to validate. A run that reached no stage names its bucket rather than inventing a location. `eval run --wait`, `status`, `gate` and `compare` inherit it through the one renderer.

The full six-row chain per failing trial is the detailed layer, behind `eval status --stages`: six rows times twenty failures is a lot of terminal, and the first-break line above already carries the answer. It renders only inside a `verified` chain — six "not measured" rows for a chain that was withheld or never recorded would state as measured-and-empty exactly what was never measured.

Human output is not a stable contract and JSON is, which is what makes leading with the chain safe. Every value still passes through the label maps: the corpus test that refuses a raw wire enum now renders both layers.
