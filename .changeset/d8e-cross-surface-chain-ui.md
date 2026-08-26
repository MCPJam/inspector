---
"@mcpjam/inspector": patch
---

D8e: the user-value chain, where a reader already is

Two surfaces, one vocabulary, and no arithmetic in React.

**Per session** — `SessionUserValueChain` renders the six stages stored on
`chatSessions.stageDerivation` beside the surface's own verdict. It explains an
outcome; it never replaces one. It refuses four things on purpose:

- It does not derive. Every row is read exactly as the backend stored it.
- It does not collapse the three non-verdicts. "we did not check", "it does not
  apply" and "it never ran" get three different sentences, because one shared
  grey dot is how "we never checked" gets read as "it passed".
- It never says "root cause". A first failed stage is _where_ the chain
  stopped, not why, and phrasing that suggests otherwise is how an operator
  ends up fixing the wrong system.
- It does not hide staleness or absence. A chain whose evidence has moved is
  still shown, labelled; a session with no chain says "not measured" rather
  than vanishing, because a panel that hides itself reads as "nothing to
  report".

**Per population** — `StageFunnel` renders one backend-computed summary. There
is no `summaries` prop and no addition anywhere in the file, so a User Testing
scenario cannot be summed into a swarm run: they answer different questions and
neither is an eval trial. A swarm wave with several runs gets one funnel per
run, side by side. Every funnel always shows the numerator with its eligible
denominator (`4/7 eligible`, not just `57%`), renders zero eligible as "not
measured" with no bar, names every excluded session (no chain / deriving /
awaiting a newer chain / derivation failed), and discloses truncation.

All user-facing words come from the SDK's canonical label maps, which are total
over their vocabularies — a new stage reason breaks the label file until
somebody writes the words a human reads, instead of silently rendering a wire
enum.

Self-hiding until the backend queries exist, so this ships dark.
