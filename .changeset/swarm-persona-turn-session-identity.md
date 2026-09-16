---
"@mcpjam/inspector": patch
---

Swarm persona turns now send the session identity the backend bills them against, so swarm runs execute again.

Every swarm session had been dying at its first persona turn. The backend mints a per-turn fee key from the wire identity and refuses the turn when it cannot, and it validates the index with `Number.isInteger(body.sessionIdx)` — but the persona turn sent `{projectId, runId, hostId, transcriptSoFar}` and no `sessionIdx` at all. The route answered `400 invalid_request` "Invalid journey session identity", every session failed before its first message, and the run surfaced "No sessions ran." with zero transcripts.

Everything downstream reads as a product finding rather than an outage, which is what made it hard to place: the rubric "Final message non-empty" fails against a transcript that was never written, clustering leaves every session "Not analyzed", and the journey diagnostic reports friction at connection. None of that came from the server under test.

The body now also carries `targetId`. Matching on `hostId` alone finds two candidates whenever two environments resolve to the same host, and the guard refuses that as ambiguous — the case `journeyRuns.ts` already names in `'Ambiguous journey attempt: multiple targets share this host; a targetId is required'`. A legacy run, whose hosts are unique, still sends none.

`sessionIdx` is bound per attempt rather than read from the loop counter. The counter is hoisted to the worker scope so the worker-level catch can finalize the attempts a target left behind, so a callback that fires later in the session reads whichever index the loop has since advanced to — session 0's turns would have been billed and validated as session 1's. `sessionBearer` already exists for exactly this reason, and `attemptSessionIdx` follows it.
