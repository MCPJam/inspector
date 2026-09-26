---
"@mcpjam/inspector": minor
---

Add range selection to the OAuth Debugger and XAA Debugger step logs.

Previously each step card only had a "Copy step" button, so sharing a
consecutive range of steps (e.g. steps 7-8) with an engineer or an AI
assistant meant copying and pasting each step separately. Clicking
"Select step" — next to the OAuth Guide view's "Copy all" button, or the
XAA Flow view's "Copy all" button — now shows a checkbox on every step
card; clicking a checkbox toggles that step, and shift-clicking another
checkbox selects every step in between. A "Copy N steps" button then
copies the selected steps together, in their original flow order, using
the same sanitized format (tokens, secrets, and cookies redacted) as the
existing copy actions.
