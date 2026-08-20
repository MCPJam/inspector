---
"@mcpjam/cli": minor
---

`mcpjam eval run` gains the full target matrix and every run knob.

The CLI could name one environment and override the server list; the web UI
could fan a suite out across every attached host or environment and set
iterations, matchers, case subsets and pass thresholds per run. Worse, running a
host-attached suite from the CLI silently executed under the suite's DEFAULT
host config — the run happened, and the result named a host that never ran it.

`--environment` and `--host` are now variadic (one value targets one thing,
several fan out), `--all-targets` runs every attached target, and
`--iterations`, `--case`, `--exclude-skills`, `--refresh-snapshot`, `--notes`,
`--min-pass-rate`, `--match-options` and `--idempotency-key` expose the rest.
`--host` is the mis-attribution fix: a run against a named host is stamped with
that host's configuration.

A suite with several attached targets no longer guesses — it fails with
`TARGET_REQUIRED` and lists every choice, because guessing here is guessing how
much to spend. A fan-out goes through the single grouped-launch endpoint, so it
occupies one concurrency slot rather than N.

`--format json` still prints exactly one JSON document, so CI can parse stdout
directly. Human format adds a `View:` link per started run, a
`Started N/M runs (group …)` summary, and a named line per failure. A partial or
wholly failed fan-out exits 1: a per-target failure does not abort its siblings,
so exiting 0 would let a pipeline read "1 of 3 runs never started" as a clean
launch.

`mcpjam eval cases run` gains `--host`, `--iterations` and `--idempotency-key`.
