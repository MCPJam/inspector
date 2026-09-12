---
"@mcpjam/inspector": patch
---

Comparison columns now resolve Browser through the same hook the single chat pane uses, instead of an inline copy of its logic. A column previously ignored the saved per-client Browser setting an authenticated user had made, and could settle on "no Browser" before that setting had loaded — so the same client could drive a browser on its own and refuse to in a column. Local Browser also follows an explicit device grant for anyone with no shared setting to read, which now covers a signed-in user on a local-only project as well as a guest; a project that never enabled Browser still keeps its answer.
