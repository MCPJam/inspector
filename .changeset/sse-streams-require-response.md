---
"@mcpjam/sdk": patch
---

Functional SSE Streams now passes a stream only when it carries the JSON-RPC response to its own request ("The SSE stream SHOULD eventually include a JSON-RPC response for the JSON-RPC request sent in the POST body"). A stream that only sent other events, such as a notification, or the response to another request, used to pass and now fails. Failures list the streams that never answered in `unansweredStreams`.
