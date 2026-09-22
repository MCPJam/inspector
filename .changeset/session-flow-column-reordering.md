---
"@mcpjam/inspector": patch
---

Let the Session flow columns be reordered. Every column in the Sankey can now be dragged into a new position, hidden, and restored from the header, and the order is remembered per surface. The headers moved out of the chart into a sticky row, so the diagram scrolls under them instead of the page scrolling through it, and the canvas widens with the column count rather than squeezing the columns it has. Adding a yes/no question opens a modal instead of an inline form, and each question column gets its own hue. An unanswered question now takes its label from the stages the server sent.

One limit to know about: the server stores counts for neighbouring stages only, so putting two columns next to each other that were never neighbours draws a link reconstructed from session paths rather than one the server measured.
