---
"@mcpjam/cli": minor
---

`--iterations` is the canonical spelling of the per-run count on `eval run`,
`eval cases run` and `eval description-experiment start`; `--repetitions` keeps
working as its legacy spelling. Passing both is still a usage error, now worded
as two spellings of one flag. The description experiment's cap is
`--max-iterations`, with `--max-trials` as the legacy spelling.

`eval export --schema-version <1|2>` chooses the suite-file dialect to write.
The default stays `1` (`repetitions`, `checks`): an exported file has no
handshake with whatever reads it later, so the newer dialect (`iterations`,
`assertions`) is written only when asked for. Both dialects load.

Nothing on the wire changes: the run operation already folded either spelling
to the same `iterationOverride`, and a file run still uploads the count under
both v1 API keys.
