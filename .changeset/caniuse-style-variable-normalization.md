---
"@mcpjam/inspector": patch
---

Read every host's style variables the same way on the compare matrix.

Hosts state the same fact in two notations: Claude sends one `light-dark(a, b)`
string, ChatGPT and Codex send a resolved literal per theme. The Apps · Styles
rows rendered those differently — a raw CSS function in one column against a
stacked LIGHT/DARK pair in the next — which is precisely the comparison the
matrix exists to make and the one it made hardest. A `light-dark(…)` value is
now split into its two themes (on the top-level comma, so the commas inside
`rgba(…)` don't end the first argument) and every host reads down the column in
one grammar. The literal the host actually sends is kept on the row and shown
on hover, and a value that cannot be split — a malformed call, a
`color-mix(…)` — is still shown verbatim rather than guessed at.

Color rows also gain a swatch over a checkerboard, so two hex strings are
comparable at a glance and a fully transparent `…-ghost` token is
distinguishable from an opaque white one.
