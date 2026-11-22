---
"@mcpjam/sdk": patch
---

Tasks checks no longer call a tool as a task on a 2025-11-25 server that did not declare `tasks.requests.tools.call`. The spec forbids that call, whatever the tool's own `taskSupport` says. The three checks that need a task (Result Type Discipline, TTL And Poll Interval Shapes, and Completed Task Carries Its Result) now show as not applicable instead of failing or not running.
