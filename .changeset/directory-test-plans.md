---
"@mcpjam/sdk": minor
---

Directory test plans are now available as data. `draftDirectoryTestPlan` turns a server's tool list into a plan that runs every tool, in the default order `orderDirectoryTestCases` gives: cases that create fixtures, then reads, then other writes, then destructive calls, with open-world calls after closed-world ones in each group. It reads each tool's read-only, destructive and open-world annotations with MCP's defaults (`directoryToolEffect`). A plan names its fixtures, the writes each tool may make, a budget and its cleanup, and any tool can be excluded with a reason. `validateDirectoryTestPlan` lists what keeps an edited plan from being authorized: a tool left out, an exclusion without a reason, a destructive case before other cases, a write with no fixture scope, a plan that treats a tool as safer than its annotations say, a fixture used before it is created or never cleaned up, and plans too large to store.

All of these are also exported from `@mcpjam/sdk/browser`.
