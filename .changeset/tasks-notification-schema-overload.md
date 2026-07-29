---
"@mcpjam/sdk": patch
---

Fix every modern `subscriptions/listen` failing with `'notifications/tasks' is not a spec notification method`. The v2 client bump to 2.0.0 tightened the two-argument `setNotificationHandler(method, handler)` overload to methods carried by one of its two spec codecs, and the tasks extension's `notifications/tasks` (SEP-2663) is by definition not one — so the registration threw a `TypeError` and took the whole subscription down, with or without a `taskIds` filter.

`OfficialSdkClientAdapter` now routes extension notification methods through upstream's three-argument schema form and unwraps the handler back to the raw notification the manager and coordinator read. The params schema is a pass-through: upstream has no wire schema for an extension payload, and validating `notifications/tasks` is already MCPJam's job in `tasks-ext-guards.ts`, so narrowing here would strip extension members before those guards run. Because the adapter is the innermost wrapper, this covers both registration sites — the subscription coordinator's `ensureHandlers()` and `MCPClientManager.addNotificationHandler` (reached by the Inspector's `onTaskStatusChanged`). The legacy `notifications/tasks/status` is 2025-11-25 spec and stays on the codec-validated path.
