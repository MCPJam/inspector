---
"@mcpjam/inspector": patch
---

The back button on detail pages (User Testing study, Swarm run) is a raised control instead of a text link. It used to be the literal character "←" in front of muted text — the same treatment the header gives to labels it cannot press. It now matches Edit and Open preview on the same row (`h-8`, `rounded-lg`), and on hover the arrow glides the way it points while the label darkens. `motion-reduce` drops the movement and keeps the colour.
