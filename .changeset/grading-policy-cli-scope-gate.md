---
"@mcpjam/cli": patch
---

`mcpjam cloud eval update` reads a suite's own grading criterion before it builds a body, and refuses a flag that names the other scope.

`--pass-threshold` alone on a suite-wide suite was refused by the API with a message asking for `--iterations` as well — and supplying it exited 0, because `settings.repetitions` plus `settings.passThreshold` in one body is how the API spells a switch *between* criteria. Two flags that each name a threshold silently re-decided every case in the suite and left the stored accuracy percent dead, with no confirmation and no audit note.

The four flags now check the suite's resolved policy first, by name and before any request: a per-case pass rate is refused on a suite-wide suite naming `--min-accuracy`, a suite-wide percentage is refused on a per-case suite naming `--pass-threshold`, and the two iteration flags are gated the same way — including `--min-iterations` on a per-case suite, which the API stores without reading. The extra read is gated on a grading flag being present, so a rename still costs one request.
