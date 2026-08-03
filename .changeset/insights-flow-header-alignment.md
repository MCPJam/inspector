---
"@mcpjam/inspector": patch
---

Fix the session flow's column headers drifting away from their columns.

The headers were a four-cell CSS grid across the full panel while the diagram
was a fixed-width SVG, so on a wide panel the SENTIMENT header sat hundreds of
pixels from the column it names — the first three lined up only by coincidence.
They are drawn inside the diagram now, at the same x as the columns, which is
the only arrangement in which they cannot come apart.

The last column also labelled to the LEFT of its bar, a defensive choice from
before the label gutter existed. That put its text on top of the ribbons
arriving at it and read as a rendering fault. Every column now labels to the
right, into the space already reserved for it.
