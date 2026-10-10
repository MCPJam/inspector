---
"@mcpjam/inspector": patch
---

Keep prompts, chat messages, tool arguments and results, request bodies, MCP server URLs and personal details out of error reports and server logs. Error reports and log rows keep their structure (keys, types, lengths, ids, codes, statuses, model and tool names) and drop the values; URLs keep their host; Sentry identifies users by id only.
