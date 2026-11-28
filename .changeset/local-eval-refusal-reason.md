---
"@mcpjam/inspector": patch
---

On a local Inspector, an eval whose client can't run on this machine now says why and what to do, such as setting the client up in the Playground, instead of asking you to contact an administrator about cloud execution. This applies to suite runs, single test cases, replays and API launches. An API launch with several targets now runs a client on this machine whenever a single launch would, instead of refusing it as if it needed the cloud.
