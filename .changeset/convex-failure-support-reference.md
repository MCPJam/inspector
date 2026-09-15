---
"@mcpjam/inspector": patch
---

Convex failures now show a sentence and a support reference instead of a stack trace. Convex stamps `[Request ID: <id>]` on every function exception, and the client used to forward that prefix, and in a dev deployment the whole server stack with it, straight into the toast. `convexErrMessage` is now a real parser of the Convex message shape: a production plain throw reads as "Something went wrong", a dev throw keeps its first `Uncaught …` line and drops every stack frame, and a `ConvexError` payload is shown exactly as the backend worded it. The request id survives as a `Reference <id>` line under the toast, which the existing hover copy button already picks up, so a user can screenshot or paste it and support can look the invocation up in the Convex dashboard logs.

`reportCaught` now tags every client error event with `convex_request_id` when the failure carries one, matching the tag the Convex to Sentry integration puts on the backend event, and `ReportOptions` takes a `tags` record for other indexed values. The Members and Sharing dialog, the organization members surfaces, the registry connect path and the OAuth debugger stop toasting a raw `.message` and report their catches, so those failures now exist as client-side events with the reference attached rather than only in Convex logs.
