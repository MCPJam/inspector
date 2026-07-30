---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Restore the Copilot host label to `Copilot` (it read `Copilot 1.0.1`).

The versioned label arrived as a drive-by in the VS Code 1.130 profile update
and made Copilot the only host of sixteen carrying a version in its name — VS
Code itself, whose real build number that change bumped, kept the bare label.
`1.0.1` is not a Microsoft build number either; it labels MCPJam's own
vendor-doc profile.

It also isn't cosmetic, because the template label becomes the created host's
name:

- Hosts created from the template (`App.tsx` quick-add, `CreateHostDialog`
  prefill) were named `Copilot 1.0.1`. `resolveHostLogoByDisplayName`
  normalizes that to `copilot1.0.1`, which matches neither the style id
  (`copilot`), label, nor shortLabel — so the Copilot mark fell back to a
  letter tile in the Playground client selector, the evals client bars, and the
  publish bar. Every other template label still matched.
- `?template=copilot` looks up an existing host by `name === template.label`,
  so anyone holding a pre-rename host named `Copilot` got a duplicate created
  instead of the one they had opened.

The emulated profile version is unchanged: `clientInfo` and `hostInfo` still
send `1.0.1`, so nothing a widget branches on moves. `compatibilityEvidence`'s
`profileLabel` drops the suffix with the label.
