---
"@mcpjam/inspector": patch
"@mcpjam/sdk": minor
---

Agents can read a suite's settings history

**The history had one reader, and it was a browser.** The settings sheet's new
history panel reads a suite's committed edits through Convex; the SDK, the CLI
and MCP could not read them at all. A `GET
/v1/projects/{p}/eval-suites/{id}/revisions` now returns the same entries —
who committed each edit, which stored fields moved, the note they left, how
many runs were launched against it, and the revision group that ties one
request's writes together.

Reachable as `list_eval_suite_revisions` from the SDK, as `mcpjam cloud eval
revisions` from the CLI, and from the MCP catalog and the in-product workspace
tools. It sits beside `update_eval_suite` on purpose: "who changed this, and
when" is the first question after an unexplained change in results, and a
revision's number is what makes the next edit a compare-and-set rather than a
last-write-wins.

**No snapshots on the list.** A page of whole suite configurations is a large
payload for a list nobody reads that way; this answers what changed and when.

**Project scope is checked on the suite first.** The revision list is addressed
by suite id alone, so without that guard a caller could read another project's
history by guessing an id. An out-of-range `limit` is a 400 rather than a silent
clamp — a caller who asked for 500 and got 100 cannot otherwise tell a capped
page from the end of the history.
