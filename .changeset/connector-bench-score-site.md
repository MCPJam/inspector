---
"@mcpjam/inspector": patch
---

Connector Bench: the score-site screens, driven entirely by the server's run row

The chrome-less score surface gains the benchmark flow — classify, price, consent, run, read — at `/embed/bench` (`/embed/bench/:runId` to resume) with its own public result link at `/bench/results/:secret`.

**The state machine is the backend's, and that is the whole design.** The conformance runner next door executes its suites in the browser, which is why it carries a `run-complete` phase to dodge a React commit race between `runAll` resolving and its results landing in state. None of that is carried over, because none of it applies: a benchmark runs on our infrastructure, every phase is a function of one `GET /runs/:runId` response, and the run id lives in the URL. Refresh, a second tab, and coming back tomorrow are all the same operation — read the run, render its status. Polling stops the moment the run is terminal, because a settled row cannot move.

**A failed classifier is never a gate.** The category selector renders the receipt's ranking with its confidence and rationale, pre-filled from what this actor chose last time — and when the classifier produced nothing, it offers the full runnable list and says so. Unrunnable categories stay visible with their reason: a target that advertises nothing must not look identical to one whose category we do not offer yet.

**The quote screen says the expensive things out loud.** The exam's identity and version, the estimate as a *ceiling* against what is available, the size of the matrix and the wall clock — and, when the exam writes, a preview of every write with an explicit tick that gates the start. A guest is told before the button, not after a cancel, that today's contribution is spent at admission and is not refundable. A `409 DEFINITION_CHANGED` refuses to start and offers a re-quote rather than silently re-pricing: the visitor consented to a specific manifest, and a new one is a new decision. (The relay now forwards the backend's own conflict code as `details`, since `CONFLICT` alone cannot tell "the exam moved" from "this run already finished".)

**The report distinguishes claims from the absence of them.** Sections render when the read carries them and the v1 three-number view renders when it does not — `sections` being absent is the only honest signal, because `core` and `composite` are populated for v1 rows too. `partial` keeps its real section scores and withholds only the Overall; it is not a failure. A slice with `score: null` says "not measured", never `0` — "scores 0 for support agents" is a claim about the connector and "no case in this exam represents one" is not. Coverage travels with every section so `not_applicable` and `insufficient_evidence` stay apart. A deprecated or deleted result still resolves and is labelled, because a link somebody shared should explain itself rather than 404. A user-chosen category is badged **User-selected · not registry verified**. And the two reruns read differently: the same definition hash is another point on one comparison series, a new hash is a new exam and a new series.

Cleanup status is reported either way — a visitor who let us write into their tenant is owed the answer even when the run failed.
