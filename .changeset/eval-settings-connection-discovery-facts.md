---
"@mcpjam/inspector": patch
---

Eval suite settings: show what actually decides Connection and Discovery

The Connection and Discovery cards on a suite's Grading tab said "Measured by
the runner — nothing to configure". Nothing GRADES those two stages — no
predicate kind files there — but a great deal configures them, and all of it
lives on the client and server rows rather than the suite. Somebody debugging a
failed connection was told to look nowhere.

Both cards now list the effective configuration for every run target the suite
fans out to: which client and server, over what transport, with which auth,
header names, protocol version and request timeout; and for discovery, tool
visibility, progressive discovery, pagination traversal and which servers get
their `tools/list` taken. Values are READ-ONLY here — they are shared with
every other suite pointing at the same client or server — so each line links to
the Hosts, Servers or Environments page that owns it.

Where a stored value is not what an eval run uses, the card says so rather than
implying either one. A hosted run builds its connection from the client, so a
timeout or capabilities override stored on the SERVER row is shown with a note
saying the run uses the client's value instead. Header NAMES are listed, never
header values.

Connection, Discovery and Call also stop being tinted like unconfigured
stages. The tint marks a gap somebody should close, and those three have no
grader to author at all — it grouped the stages that need nothing with the ones
still waiting on the reader. The tinted stages (Selection, Response, User
value) also lose the block of empty space under their content.
