# AGENTS.md

Repository-wide instructions for AI coding agents. Package-specific rules live
alongside their code — see `mcpjam-inspector/AGENTS.md` for the inspector app.

## Design

**Read [`DESIGN.md`](./DESIGN.md) before any UI or styling work.** It describes the
MCPJam design system — color roles, typography, layout, elevation, shapes, and the
component primitives — in the open DESIGN.md format, so it is equally readable by
agents working outside this repository.

- `design-system/src/tokens.css` is the single source of truth for the palette.
- `DESIGN.md`'s YAML front matter is **generated** from it. So are the fenced blocks
  in `docs/style.css` and `chat-ui/src/styles.css`, and the derived color fields in
  `docs/docs.json`. Never hand-edit a generated region.
- Change a color by editing `tokens.css`, then run `npm run design:sync`.
- `npm run design:check` (drift) and `npm run design:lint` (spec) both gate CI.
- Never write a literal hex or `oklch()` value into a component — use the role
  tokens. Role values live in `design-system/src/tokens.css` and nowhere else.
- A package-local accent palette that is deliberately outside the role system
  is the one exception (chat-ui's `--trace-waterfall-*` is the existing one).
  Adding another is a real decision, not a shortcut around the rule: it will
  not track the theme, and nothing will check it.
