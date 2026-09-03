---
"@mcpjam/inspector": patch
---

A failed connection reads as a title and a failure, and copies as both

The toast said `Excalidraw (App): Request failed (500)` — the server and the
failure spliced into one run-on line by a colon, with sonner's error icon
aligned against the middle of it rather than a title. It now uses the two
fields sonner renders: the server name as the title, the failure as the muted
description below it. The single-line form is kept for the message that already
names the server, where a title would print the name twice.

One failure also produced two differently-worded toasts. `ServerDetailModal`,
`ServerConnectionCard` and `RecommendedServers` each caught the throw and built
their own sentence around it ("Failed to connect to X: …") while the connection
layer was already reporting the same failure in its own words. All three now
raise it through one helper, so the wording matches wherever it comes from. The
duplicate report itself is untouched and still open.

The error toast's copy button copied only the line it sits on, which after the
split is a server name and nothing else. It now takes the description with it.

Error-toast action buttons no longer claim a full centered row of their own.
The Toaster forced that because a sentence-long CTA squeezed the message beside
it, but it also stranded short labels — "Retry", "Reconnect" — under a one-line
error at four times their width. The toast content grows instead, so the label
decides: a short button rides the title row at the trailing edge, and one that
no longer fits wraps to its own line.

Two layout fixes come with it. The toast aligns its icon and action to the
first line rather than the middle of a paragraph, and a paragraph no longer
forces its own row and strands the icon alone above it. And the copy button no
longer overflows the message box it sits in: at 20px against a 19.5px line it
raised a native scrollbar — arrows and all — over a one-line error.
