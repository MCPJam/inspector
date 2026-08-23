---
"@mcpjam/inspector": patch
---

Show a host's MCP Apps style tokens in the Apps tab.

The Apps tab gains a read-only "Style tokens" block listing the
`hostContext.styles` payload the host hands a view on `ui/initialize` — every
style variable with its light and dark value, grouped by family (background,
text, border, ring, type, shape, shadow), plus the `css.fonts` string. Each row
previews what the token drives: colors as a split light/dark swatch over a
checkerboard so alpha reads, radius and shadow as the shape they produce, and
type tokens as a glyph rendered in that token's own family, size or weight. Clicking a row copies `var(--token)`, the form a widget
author pastes into their own stylesheet.

Values are resolved through the same resolver the widget host uses — the
registry preset named by `hostStyle` with the host config's persisted
`chatUiOverride` layered on top — so a BYO host that stores its own palette
shows its real tokens rather than the preset's, and nothing is re-declared for
display.
