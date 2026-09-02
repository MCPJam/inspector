---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

A passing trial can have its chain read too

D9's decision summary carries a per-trial user-value chain, and the browser already fetches it — for **non-passing trials only**. That filter lives in the contract assembler and is deliberate: diagnostics are evidence beneath a verdict, and a trial that passed is not evidence of anything going wrong. The consequence is that a reader who opens a trial that succeeded has nothing to read, and "how far did value travel here" is exactly as good a question about a passing trial as a failing one.

The iterations resource projects the same stage columns over every row of a run, passing included — verified against production, where all ten trials of a run came back carrying six rows each. This adds the client read for it.

**One chain type, one validator.** The rows go through the contract's own chain assembler, now exported as `assembleEvalRunDecisionChain`, which is the same function D9's summary is built from. So the result is `EvalRunDecisionChain` — the type the decision card and the trial cards already render, with no adapter and no second shape — and the **whole derivation** is validated rather than the rows one at a time. Row-level validation accepts five rows, or six in the wrong order, and a renderer that numbers cards `01`–`06` by position would then publish a different claim about which stages were blocked, because `notReached` is derived from position. A test feeds it both shapes and pins that they come back `unverified`.

**Three absences stay three facts.** A bare 404 from a router that never had the path is a deployment that does not serve iterations; an enveloped `NOT_FOUND` is a run that is not there; a row with no derivation is `absent`. Reading the first as the third would report every trial on an undeployed build as having no chain.

**Keyed on the run's revision, not just terminal status.** A terminal run is not frozen — a judge landing minutes later rewrites `judgePending` into `judgeObserved`, which is a different chain for the same trial. The read keys its cache on the same revision marker the decision-summary store uses, so the two refresh together and one trial can never show two chains at once.

**Silent unless asked.** Off without the caller's switch, a project id, and a finished run; with any missing it issues no request at all.

The route needed an entry in `authFetch`'s bearer allowlist, and the existing eval-chain test already pinned it in the negative list — so this is a **move**, not an addition, and the test now pins that the trace and per-iteration paths beneath it are still *not* granted. Without the entry the read ships no `Authorization` and the 401 surfaces as "could not be loaded", which reads as a backend outage while the API is fine. That has happened three times before on this surface.
