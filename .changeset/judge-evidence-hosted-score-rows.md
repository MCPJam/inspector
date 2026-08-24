---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
---

Let a judge verdict feed the user-value stage chain, and emit hosted score-contract
rows behind a grading-engine mode gate.

The stage analyzer gains an advisory tier-2 input: `StageEvidence.judgeEvidence`,
consulted only where deterministic evidence said nothing. A judge can never
overturn a predicate failure, can never survive an upstream stage failure, and
cannot introduce a failure category — it fills `noEvidenceCaptured` with
`judgeObserved` / `judgePartial` / `judgeFailed` / `judgePending` /
`judgeNotRequested`, and analyzer version becomes 3 so an operator can tell which
rows were derived under which rules.

Hosted iterations can also produce `ScoreResult` rows, resolved through the
existing contract helpers rather than any new arithmetic. Nothing changes until an
operator flips `MCPJAM_GRADING_ENGINE_MODE`: `off` (the default) is byte-identical
to today, `shadow` writes shadow-only keys, and `dual_write` writes the real ones.
The judge scorer is `role: "advisory"`, so it is structurally incapable of gating.
`passed` remains the sole authoritative verdict in every mode.
