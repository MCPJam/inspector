---
"@mcpjam/inspector": minor
---

Replace the chatbox Insights goals-by-outcome grid with a four-stage session
flow: goal → behavior → outcome → sentiment.

Every column is an emergent theme, clustered independently from the sessions
themselves, so the behavior column can read "Guessed an id after truncation" —
a name no fixed list would ever have contained. The closed enums still exist
underneath and still back every rate; they are simply not what the diagram
draws.

Selection is theme-based throughout. A node click selects one theme, a link
click selects the two it joins, and chips carry their axis so a theme on the
behavior column cannot be mistaken for one on the goal column. Chips group per
axis as well as match per axis: they OR within an axis and AND across, which is
what makes a link selection narrow to the intersection instead of widening to
either endpoint.

Two fixes to the panel's filter plumbing:

- Opening or closing a flow now subtracts only that selection's own chips, by
  identity. Clearing the axis wholesale also threw away a community the user had
  picked on the topic map, silently widening the cohort behind their back.
- The drill-down's request key now includes the selection explicitly rather than
  relying on it to appear in the filter, so paging always resets when the
  selection changes.

The diagram is laid out directly instead of through recharts. Its `Sankey`
recomputes node order and offers no way to keep a column in the volume order the
server sorted it into — the one ordering that means the same thing across
chatboxes. Owning the geometry also made the whole thing keyboard-operable and
assertable in tests, neither of which was true of the SVG recharts produced.

Requires a backend at signals version 3. A chatbox analyzed before every column
was clustered still renders its goal column and offers a rebuild.
