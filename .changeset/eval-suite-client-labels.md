---
"@mcpjam/inspector": patch
---

Suite surfaces say Client where they meant the product noun

The Client rename reached the CRUD surfaces and stopped. Three leftovers, no
logic touched: the suite revision history labelled its two attachment fields
Host and Hosts, the create-suite dialog said a server group is what "all hosts"
run against, and the router comment explaining the `/clients` → `/hosts`
redirect claimed the tab was renamed "Client → Host" — the opposite of what
happened, which is the one thing a comment about a rename must not get wrong.

`hostStyle`, `/host-catalog`, `clientCapabilities`/`clientInfo` and the secrets
broker's `Hosts` field (which is a list of DNS hostnames) are all different
concepts and are untouched.
