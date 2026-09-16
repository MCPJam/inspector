---
"@mcpjam/inspector": patch
---

Swarm Findings no longer reports findings about a server whose sessions never ran.

When a run is refused before any session executes — the provider rate-limits the key, the launch is rejected, the target never connects — there are no transcripts to reason about. Rubric verdicts, the judge rollup and detector candidates all describe sessions, so on such a run they described nothing, and the stages they lit up read as friction the server under test had caused. The journey diagnostic reported "friction at connection" and the persona was left `UNEASY`, both derived from sessions that produced no messages.

That is what made the persona-turn outage read as "Swarms is broken" for three days rather than as one endpoint returning 400. The Run tab said what had actually happened the whole time; every other surface contradicted it.

A settled run with no successful sessions now contributes only its connection row, which reports launch outcomes and is captioned as such. The goal falls through to "Nothing graded yet" and `Unscored` — a state the derivation already had and that the fabricated evidence was routing around.

`goalSentiment` now excludes the connection stage, matching `goalDiagnosis`, which already excluded it and cited the same reason: launch outcomes are not a finding about the server, and a feeling word is a claim about the experience the server delivered. The two had disagreed, so a run could report "Nothing graded yet" and `Uneasy` at the same time.

This narrows what Findings claims; it does not change what ran. Runs whose sessions executed are untouched.
