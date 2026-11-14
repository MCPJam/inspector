---
"@mcpjam/inspector": patch
---

A hosted readiness run's tool tests run as the submission's reviewer account, the one its reviewer sign-in connected, and never on the saved server's own credential. A run without a reviewer account lists and calls no tool, and its report says why and what to do. Each call in the run's record names the reviewer account it ran as, so a result recorded under another account reads as stale. A case that uses a fixture the reviewer path looked up and did not find is not sent: it is reported blocked, naming the fixture. The reviewer section names a test plan fixture by its id or by one of its values.

A submission that says its server needs no sign-in (the Claude form's authentication answer "None") is tested as a directory's reviewer reaches it: with no credential at all, and its calls record no account. If the server refuses a connection with no credential, the report names the mismatch with the submission's answer.
