---
"@mcpjam/inspector": patch
---

Every saved settings change is a numbered suite revision, with a history

**The record existed and nothing showed it.** Since the draft-and-commit sheet
shipped, every save has written a numbered revision carrying who made it, which
fields it touched, the note they left and how many runs are pinned to it. "Who
turned the judge off, and when?" was a question the product had already answered
and never displayed. The settings header now carries an "On r7 · History" pill
that opens a slide-over with those entries, newest first, and clicking one shows
the before/after of the fields that actually moved.

**Storage keys are translated, and unknown ones are still shown.** A row that
read `defaultPredicates` would ask a reader to know the schema to connect it back
to the Checks control they edited, so the list names the settings row instead. A
key with no label renders raw rather than being dropped — an unnamed change is
still a change, and hiding it makes a revision look emptier than it was.

**The Done button is gone.** It told a reader the settings sheet was a form to
fill in and submit, which it has not been since the commit bar shipped: Done
only navigated, and the save has lived in the bar. The breadcrumb is the way
back, and the corner it occupied now answers the question a reader of a shared
suite actually has.

**The pill hides rather than guessing.** On a deployment that does not record
revisions there is no number, and "r—" is one a reader cannot tell from a suite
nobody has ever edited. The history query subscribes only while the panel is
open.
