---
"@mcpjam/cli": patch
---

`mcpjam cloud eval update` reads a suite's own grading criterion before planning the write, preserving scope and refusing incompatible iteration edits.

`--pass-threshold` alone on a suite-wide suite was refused by the API with a message asking for `--iterations` as well — and supplying it exited 0, because `settings.repetitions` plus `settings.passThreshold` in one body is how the API spells a switch *between* criteria. Two flags that each name a threshold silently re-decided every case in the suite and left the stored accuracy percent dead, with no confirmation and no audit note.

Grading flags now use the canonical edit planner after reading the suite. `--pass-threshold 0.9` writes `minimumAccuracy: 90` on a suite-wide suite and `passThreshold: 0.9` on a per-case suite, preserving the criterion. The iteration flags refuse edits the current scope cannot represent. Conflicting flags are refused before the read; changed edits carry a revision precondition, and unchanged grading edits skip the PATCH unless other edits remain. A rename without grading flags needs no grading pre-read.
