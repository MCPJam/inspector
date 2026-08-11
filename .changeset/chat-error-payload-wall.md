---
"@mcpjam/inspector": patch
---

Stop rendering a gateway's HTML error page into the chat.

When an upstream hop fails, the response body is an HTML document, and the AI SDK surfaces the failure as `new Error(await response.text())` — so the entire page landed in `error.message` and rendered verbatim, filling the chat with a wall of red markup and pushing the conversation off screen. A user demoed exactly this on a call: a 502 whose only readable content was the phrase "Bad Gateway" buried in the middle of a stylesheet.

An opaque or oversized payload is now summarized to one line — "The request failed with HTTP 502. An upstream service returned an error page instead of a response." — with the original body preserved in the existing "More details" collapsible. The copy says "an upstream service" rather than "the server" because the page comes from whichever hop failed, and naming "the server" in an MCP debugger reads as an accusation against the user's MCP server.

The status is read from the page's `<title>` and `<h1>` — both, in order, since a generic `<title>Error</title>` over an `<h1>503 Service Unavailable</h1>` is a real page shape — rather than by scanning the document for any three-digit number (the page that prompted this carries `500` and `404` inside a stylesheet). Detection covers bodies that are not well-formed documents: truncated or streamed responses that never reach `</html>`, and pages behind a comment or an XML declaration.

Ordinary error text is untouched: only genuinely opaque or oversized bodies take this path. The error card and its details pane also gained height caps, so a message that slips past the formatter costs a scrollbar rather than the viewport.
