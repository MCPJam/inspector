---
"@mcpjam/inspector": patch
---

A reused persona's iterations can be set for the run you are about to launch.

Confirm showed reused goals as read-only text — "5 goals at the iterations already saved = 25 conversations" — so bringing a persona in meant taking whatever its owner had saved. One in the recording arrives at 25 conversations with no way to bring it down, which is the opposite of what someone reusing a persona for a quick run wants, and it spends model quota that is already rate-limited.

Reused cards now carry the same iterations stepper the authored ones do. The control starts at what the persona's goals already hold, so leaving it alone launches the size it always did; goals that disagree, or carry nothing saved, start at the default instead, because there is no single saved value to show and picking one would misreport the others.

The number is sent as a per-run override and the shared journey is not rewritten, which was the reason the control was withheld in the first place. A persona reused across swarms keeps its own saved size for everyone else.

The launch quote follows the same number, so what Confirm promises and what the run fans out to cannot disagree.
