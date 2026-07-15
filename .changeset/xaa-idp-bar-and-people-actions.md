---
"@mcpjam/inspector": patch
---

XAA debugger polish: tighten the IdP bar and surface Run-as chip actions.

- **IdP bar:** the issuer guidance that occupied a two-row block under the card now collapses into an info tooltip next to the hosted-issuer switch, so the assertion-format and hosted-issuer controls stay on the toolbar row. The hosted-issuer and local-URL explanations (including the anonymous test issuer caveat) are unchanged in substance — they moved from always-on prose into the tooltip, and the separate `anonymous-issuer-badge` chip is dropped now that the anonymous caveat reads inline in the hosted-issuer hint.
- **Run-as chips:** edit and remove are always visible instead of appearing on hover, and each chip gains a dedicated remove button (previously deleting a person meant opening the edit popover first). The chip border/selection ring moved to the wrapper so the select, edit, and remove controls read as one pill. Removal deselects the person if they were selected and closes their edit popover.
- The existing run-in-progress guard still covers every chip action, and now also covers a chip whose own removal is in flight.
