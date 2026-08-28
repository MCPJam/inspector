---
"@mcpjam/inspector": patch
---

Skills tab: the header count tells the truth, and a row only says what makes it different

**"Skills 0" over a list of skills.** The header badge counted the project store alone. That was unambiguous while server-served skills sat under a heading of their own, and became a plain falsehood the moment both halves became one flat list — a signed-out user with a connected server saw `0` above a panel of visible rows. A badge next to a list is read as the length of that list, so it now counts both halves. The two really are different namespaces (a name here, a URI there); that distinction lives on the rows, which name their origin server, not in a number nobody reads that way.

**A green shield with a bare number on every row.** The number was the file count of the skill's advertised manifest, and the shield meant the skill was digest-verified — which every listed skill is, because verification is mandatory rather than something a skill can win. So the badge distinguished nothing and the number had no reading. Both moved into the row's tooltip, next to the skill URI. What stays on the row is the amber `unverifiable — declined` badge: the one row that behaves differently is the one worth marking.

**A block of dead space above the rows.** The project store's "No skills available / Upload your first skill" call to action rendered on the project store's own count, so it appeared — a centred hundred-odd pixels of it — between the header and server rows that were right there. Both placeholders now speak for the whole list: they render only when the whole list is empty, and below the rows rather than above them. The server section reports whether a listing is still outstanding, so an unanswered fetch no longer reads as an empty store and then flashes away when the rows land.

**The per-server "load by URI" input is gone.** `skills/get` still answers for a URI a listing never mentioned — that capability has not moved, and the tab still uses it to open a row — but a text box under every server was a debugging tool priced as permanent furniture in a panel whose job is to show what a server serves. It is available on `mcpjam skills get` and on the `/v1/…/skills/get` REST endpoint.
