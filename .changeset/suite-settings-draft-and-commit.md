---
"@mcpjam/inspector": patch
---

Eval suite settings are a draft you save, not a form that saves as you read it

Every control in the settings sheet used to write the moment you touched it. A dropdown, a toggle, a text field: each fired its own mutation and its own toast. Three things followed, and all three were reported rather than predicted.

- **There was no way to not save.** No Cancel, because there was nothing uncommitted to cancel. Opening the sheet to check a setting meant risking changing it, and the only way to find out whether you had was to close it and look again.
- **There was no unit of change.** Adjusting four related settings produced four writes and four toasts, none of which was the change you made. Anyone reading the suite later saw four unrelated events.
- **Two people editing one suite silently overwrote each other.** Each write succeeded, last one won, and neither person was told.

The sheet now holds a draft. Edits accumulate, a bar appears with a count, and Review and save shows what will change — before and after, per setting — with an optional note that lands on the suite's revision so the next reader gets a reason instead of a diff to interpret. ⌘S opens the review rather than saving, because in a sheet with a review step the honest response to "commit what I did" is to show you what that is.

- **One write, carrying only what changed.** A save that resent every field would clobber a colleague's edit to a row you never opened. The clearing semantics each control had are preserved exactly — the backend distinguishes an omitted field from a cleared one, and getting that wrong means a setting you cleared is still there on reload.
- **A concurrent save is refused, and your draft survives.** The save carries the revision you loaded. If someone saved first, the sheet keeps your edits, marks the settings you both changed, and asks you to look — rather than discarding your work, which is the outcome the check exists to prevent.
- **Renaming moved into the sheet.** It was an inline header edit that committed on blur, so a stray click saved a half-typed name to a suite other people watch.
- **Leaving with unsaved changes now asks.** In-app navigation and closing the tab are separately handled, because either alone leaves a whole class of exits silent.

The debounced default-checks committer is gone, along with the pass-criteria localStorage mirror. Both were machinery for saving on every keystroke — a debounce that had to serialize its own writes so an out-of-order response could not persist stale text, and a local mirror so a value the server had not accepted yet survived a reload. Neither has anything to do now.

Environments, the schedule and client attachments still save immediately and say so in their hint. Each has cross-field validation a batched save would have to re-implement, and re-implementing a validation is how the two copies come to disagree.

On a deployment whose backend predates the composite save, the sheet detects the missing function once and falls back to the previous mutation. Everything still batches into one write; only the revision history is absent.
