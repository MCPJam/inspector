---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Conformance timeouts are reported per check. A protocol check the server does not answer within the check timeout (`checkTimeout`, the CLI's `--check-timeout`) now reports that it could not run, with a `timedOut` marker in its details, instead of failing and marking every check after it unhealthy. The checks after it still run, until two in a row time out; the rest are then skipped as could-not-run without a timeout marker. Checks that only read connection data do not reset the timeout count. `isTimedOutCheck` is exported from `@mcpjam/sdk` and `@mcpjam/sdk/browser`.

Hosted runs give each protocol check 15 seconds, matching the CLI default, and end a protocol or apps run that passes 85 seconds with a 504 that names the limit. The report card tags timed-out checks "Timed out", names them in the verdict, and explains above the suites that a timeout is untested rather than failed. A suite cut off by the proxy reads as too slow instead of "Request failed (524)".
