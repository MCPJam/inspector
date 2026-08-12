---
"@mcpjam/inspector": patch
---

Stop pasting a gateway's error page into the chat, and offer a retry instead of only a reset.

An upstream hop answering with HTML was already summarized in the banner headline, but the page itself was kept — truncated to 4KB — as the "More details" payload, so a momentary 502 in front of `app.mcpjam.com` still put `<!DOCTYPE html>` onward, a Cloudflare status table and a datacentre name into a User Testing transcript. The banner's only action was `Reset chat`, which for a User Testing session means discarding the data the session existed to collect.

The page body is now discarded outright. The banner says the useful thing — "MCPJam was briefly unreachable. Nothing in this chat was lost — retry to send your message again." — and "More details" carries status plus the gateway's own request id (Cloudflare's `Ray ID`, or the `Request ID` / `Correlation ID` its peers print), which are the only two facts on such a page anyone can act on.

The formatted error also carries `code: "upstream_error_page"` and `isRetryable`, and the chat surfaces render a Retry beside the reset for it — resending the last message is the entire fix for a transient upstream failure. The retry is gated on that code rather than on `isRetryable` alone, which the server also sets on failures a blind resend cannot help with.

Ordinary error text and oversized-but-readable messages are untouched: only a response body that is an error page takes this path.
