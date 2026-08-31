---
"@mcpjam/inspector": patch
---

The canonical run analytics re-ask when the run finishes, and their failures stay visible

Two review findings on the run-detail chain slot.

**A run opened mid-flight never got its document.** The document is materialized when a run terminalizes, so a page opened while the run is still going asks too early and gets a legitimate 404. The effect keyed only on the ids, so it never asked again: the run finished, the document appeared, and the page kept showing the older rollup until somebody reloaded it.

The run's status is now part of the read's identity — collapsed to *"is it over"* rather than carried through raw, so a run moving `pending` → `running` does not issue a request per status tick. Callers that track no status keep the old single-shot behaviour, so a status the hook never learns cannot turn into a read it never issues.

**A real read failure could be hidden by the gate meant to hide empty ones.** If the canonical read failed with `requestFailed` or `invalidContract` on a run with no legacy rollup and no other insight card, `hasStageFunnel` was false, and both the rail and the insight band suppressed the whole slot — including the service note written specifically to report that failure. The one case where the message is the only thing there is to say was the one case it did not appear.

A service note now counts as content. `absent` and the dark-ship window still report none, so a run that finished before the materializer shipped does not hold a rail open on a message about nothing being wrong.

Mutation-checked: removing the terminal-status refetch, refetching on every status tick, and dropping either note case each fail exactly their intended tests.
