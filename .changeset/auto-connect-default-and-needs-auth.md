---
"@mcpjam/inspector": minor
---

Servers connect when you open a project, and "needs you" no longer reads as "broken"

MCP hosts like Claude Code just connect your servers on open. MCPJam did not: auto-connect was off by default, and when it was on the Servers tab was loud and often wrong. Three defects stacked up, and each had to be fixed before the next one was safe to ship.

**The toggle could not express "on by default", and it lied.** It was derived by comparing the project's enrolled server ids to the catalog for exact equality. A fresh project (no enrolled ids) read OFF with no default-on state to write — and adding one server while it was ON made the sets unequal, so the switch flipped to OFF while the other N servers carried on auto-connecting. Turning it off was also destructive: it sent "no servers, no overrides", and because the backend rejected an override for a server outside the pool, every stored header, timeout and protocol pin in the project went with it. The switch now reads and writes an explicit mode, and overrides are independent of enrollment, so turning auto-connect off is reversible — flip it back on and your per-server configuration is still there.

**"Needs authorization" was rendered as "Failed".** There was no needs-auth state, so every OAuth server without live tokens painted a red dot, a red Error pill, an ErrorCard and a "Check troubleshooting" link — for a server that is reachable, correctly configured, and one click from working. Status now reads three ways: **working / needs you / broken**. A server waiting on a human shows amber with an Authorize button and none of the failure affordances. A server that still 401s *after* a completed OAuth flow stays red, because signing in again cannot help — that one really is a config problem.

**Switching hosts announced itself.** The client-switch recycle raised a "Reconnecting N servers…" toast that flipped to "Reconnected N servers." on every host change. Switching hosts is routine navigation, and the rows already animate through connecting. Only a multi-server failure toasts now — several at once means the network, not one bad URL.

Alongside those:

- A transport failure is retried three times over about fifteen seconds, so a server that was merely still booting when you opened the project ends up green instead of needing a manual click. The card does show the failure between rounds — the attempt genuinely did fail, and the retry counter says how many times — but the retries are automatic and you no longer have to do anything. Failures a retry cannot fix — a protocol-version pin the server does not offer, a server waiting on authorization — are not retried at all. `Failed (N)` finally means something; it used to always read `(0)` because nothing incremented the counter.
- Servers that have settled as broken fold into a collapsed "N servers need attention" section below the grid. Your manual drag order is untouched: a server that recovers reappears exactly where you put it.
- A per-server "Skip on auto-connect" in the card's actions menu, so one chronically broken server is not a reason to turn auto-connect off for the whole project.
- In cloud mode, stdio and `http://` servers get a neutral chip explaining the deployment instead of a red failure. They were previously attempted anyway, failed in the transport, and were painted as broken — for something no retry can fix.
- A per-device "On this device" switch beside the project-wide one, so auto-connect can be turned off for yourself without changing it for your team (and without being a project admin).
