---
"@mcpjam/inspector": patch
---

Provider-error attribution reaches the local path, and stops over-claiming on the harness

Two catch sites turned out to be broader than the comments above them claimed. Both were found in review, and both are the provider-error defect wearing a different coat — attributing to the model a failure that never reached it, which misleads a report card exactly as much as the original did.

**The harness reports setup failures through the same callback as stream failures.** `runHarnessTurn` wraps its entire turn — preparation included — in one `try`, so a missing `projectId`, a missing auth bearer, or disabled broker credential delivery arrives at `onEngineError` looking precisely like a provider outage. `failTurn` tagged every one of them `model`, which files our own setup bug as the provider's.

The engine now reports the **phase** it failed in, derived from the trace-started flag the emitter already holds to decide whether a turn happened at all — never from reading the message. `failTurn` reads that phase. An engine that reports none still means `model`: every emitter that omits it today is a real stream failure, and defaulting the other way would un-attribute the outages this work was built for.

**The local path carried no source at all.** When `orgByokRuntime.kind === "local"`, execution goes to `runLocalIteration` rather than the hosted driver, and neither of its finish calls supplied a `stepError`. So local-BYOK trials that died on the model call still finalized with blank stage reasons and no failure category — the exact misattribution the original change removed, surviving untouched on the path it never covered.

The local driver now records the layer at both of its error sites, and threads it through both finish paths:

- **An empty model stream** is unambiguously the model call — no other layer reaches that branch.
- **A non-tool error span** is the model call **only when its category is `llm`**. That branch selects every non-tool error span, and `connection`, `discovery` and `oauth` spans are all reachable there; tagging those `model` would blame the provider for a server we could not reach.

Anything else leaves the source unset. An absent source attributes nothing, which is the right floor — no attribution is strictly better than a confident wrong one.

Both decisions are extracted as small pure functions (`failedLayerForEngineError`, `modelLayerForErrorSpan`) so the choice can be read and tested on its own rather than inferred from a call site's position. Mutation-checked: ignoring the phase, tagging every span, and tagging none each fail exactly their intended tests.
