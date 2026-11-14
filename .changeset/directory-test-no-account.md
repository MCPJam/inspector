---
"@mcpjam/sdk": minor
---

`summarizeDirectoryToolTests` takes `account: null` for tests run with no account, on a server that needs no sign-in. A call record without an account was made with none: it reads as stale once tests run as a reviewer account, and a record made as a reviewer account reads as stale when tests run with none. Leaving `account` out still compares no accounts.
