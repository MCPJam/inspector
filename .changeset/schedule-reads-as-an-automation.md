---
"@mcpjam/inspector": patch
---

The schedule row reads as an automation with a state, an owner, and a history

**"Scheduled runs on" hid the three things that go wrong with a schedule.** It
runs as a person, and pauses itself when that person loses access to the suite
— nothing on the page said whose access was being spent, so nobody knew a
colleague leaving would stop their monitoring. It pauses itself for two other
reasons too, and keeps `enabled: true` when it does, so a reader who saw the
switch in the on position had no way to learn the suite had not run in a week.
And it has a history the settings row could not show at all.

The row now leads with the state — Active, or Paused with the reason the editor
already had — names the person it runs as, says when the next run is due, and
shows the last five scheduled runs as result dots. An inconclusive, cancelled or
timed-out run is neutral, never red: those are runs the suite could not measure
well enough to decide, and painting one as a failure blames the server for the
grader.

**A schedule stranded by its owner's departure can be taken over.** Pause and
Resume are one click; "Take over" appears only for a lost-authorization pause,
because that is the only state the backend will re-mint a delegation from.

**The editor is unchanged and still saves immediately**, now behind Manage. The
old row's copy claimed it ran "render checks and prompt tests"; it runs the
whole suite, which is what the new copy says.
