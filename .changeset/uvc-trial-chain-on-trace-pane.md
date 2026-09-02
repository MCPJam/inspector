---
"@mcpjam/inspector": patch
---

The trace pane opens with the chain, not just the transcript

"View trace" lands a reader on one trial's transcript — the place they arrive when they want to know why that trial did not deliver value. The answer was not on that screen. It was back on the run page, inside a diagnostic row they had already navigated away from, and for a trial that PASSED it did not exist anywhere.

The chain now sits above the transcript: six cards, opened on the break, with the "what happened" card under whichever one the reader selects. A passing trial reads as the delivery story end to end — Session connected → Tools and resources discovered → … → Request satisfied — which is the first time that story has been visible for a trial that worked.

**`IterationDetails` does not fetch it.** It has five hosts and knows only its iteration: not the run, not the project, not whether the Evaluate opt-in is on — and the chain read needs all three. So it takes a slot, and the one host that can answer those questions builds the node. The other four pass nothing and issue no request, which keeps a shared component free of a read four of its callers never asked for.

**The hooks sit above the early return, and that placement is load-bearing.** The editor returns a loading state before its test case resolves, so a hook called below it runs on some renders and not others — React reports that as "rendered more hooks than during the previous render". A test caught exactly that, on the first draft.

Selection uses the same `undefined`-is-not-`null` rule as the run page: `undefined` means "not chosen yet" and derives the default at render time, `null` means the reader closed the card. The distinction is what makes the trace pane work at all — the chain arrives *after* mount there, so a state initialized once from an empty chain would compute `null` and never auto-open the break.

An absent map key means "not loaded", never "no chain": a trial the page walk has not reached renders nothing rather than a false absence.
