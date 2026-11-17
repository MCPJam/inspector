---
"@mcpjam/sdk": minor
---

Export `parseModelRates`, which reads a rate card from a public price row, an organization rate or a local override. It returns undefined unless the card is in US dollars with input and output rates, and drops invalid optional rates so the tokens they would price count as unpriced rather than free.
