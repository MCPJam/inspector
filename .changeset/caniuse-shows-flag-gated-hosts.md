---
"@mcpjam/inspector": patch
---

Show Claude Code and Codex on the public caniuse surfaces.

`claude-code-host-enabled` and `codex-host-enabled` gate the New Host template
picker while those profiles are iterated on, and are scoped to @mcpjam.com
users. The public caniuse pages consulted the same flags, and both hooks read
an unresolved flag as off — so the two hosts were invisible to every anonymous
visitor. caniuse documents what a third-party host supports, which is a
different question from whether MCPJam will let you create one, so the gate no
longer applies there.

The signed-in Host Compare keeps it: a preset column there sits beside hosts
you can actually create. The Compat tab and the template picker are unchanged.
This also settles a disagreement between the two public surfaces, where the
capability page hid only Claude Code while the compare matrix hid both.

Both hosts land past the six-chip inline limit, so they appear in the compare
matrix's "More" menu rather than the default row.
