---
"@mcpjam/inspector": patch
---

A failed connection reads as a title and a failure, and can be copied

The toast said `Excalidraw (App): Request failed (500)` — the server and the
failure spliced into one run-on line by a colon, with sonner's error icon
aligned against the middle of it rather than a title. It now uses the two
fields sonner renders: the server name as the title, the failure as the muted
description below it. The single-line form is kept for the message that already
names the server, where a title would print the name twice.

The toast also carries a Copy action, which writes the attributed line to the
clipboard. It is the only place a failure appears for a server that never
reached a card, and it is gone in seconds — the same friction that made error
card text worth copying. A caller with an action that fixes the failure passes
its own, since sonner renders one and "Change protocol version" outranks
copying.

Error-toast action buttons no longer claim a full centered row of their own.
The Toaster forced that because a sentence-long CTA squeezed the message beside
it, but it also stranded short labels — "Copy", "Retry", "Reconnect" — under a
one-line error at four times their width. The toast content now grows instead,
so the label decides: a short button rides the title row at the trailing edge,
and one that no longer fits wraps to its own line on its own.
