---
"@mcpjam/sdk": patch
---

`server doctor` no longer blames the server when MCPJam is the reason skills went uninspected

The skills check reports `skipped` when Skills over MCP is not active on a connection, which is right — most servers serve no skills and calling that a failure would make the doctor cry wolf on almost every run. But `active` is the AND of two independent declarations, and the check read only that boolean, so one message covered both sides: "the server must declare the extension and the client must advertise it."

That sentence is true and useless in the case that matters. `runServerDoctor` advertises the extension itself, so the only way to reach "server declared, client did not" is a caller who pinned an exact client-capability set — `--host cursor` and friends. That caller is asking "what would this host see", and the honest answer is that the host is the reason there is nothing to see. A server author running the doctor behind a host pin, against a server whose skills serving works perfectly, previously read "not active on this connection" as their own bug.

The two cases now say which side withheld the declaration, and the whole-run status stays `skipped` in both: a host pin is a legitimate way to run the doctor, not a defect in the server being examined. This also settles an internal disagreement — the CLI's `skills` verbs already refuse this exact case by name, so the doctor was contradicting them on the same connection.

The ok line also names its own sampling cap. The check verifies at most five skills, so a 200-skill server used to be summarized as "200 skills discovered. 5 verified against their manifests", which reads as "only 5 of them check out" — a much worse claim about the server than the true one. It now reads "5 of 200 sampled and verified" when the cap bit, and is unchanged when the whole catalog was verified.
