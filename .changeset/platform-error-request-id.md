---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

Failed platform API calls now say which request failed. `PlatformApiError` gains `requestId`, read from the response's `x-request-id` header (the id the API logs the request under), including on the two `INTERNAL_ERROR`s synthesized from a real response: an unreadable body and a non-JSON success body. Client-side failures (`NETWORK_ERROR`, `TIMEOUT`, `status: 0`) never reached the API and carry none, and a header not in the shape the API mints is dropped. The CLI puts the id in the error's JSON `details` as `requestId`, so a bug report can quote it and be joined to the server's logs.
