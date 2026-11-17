---
"@mcpjam/inspector": patch
---

The reviewer sign-in opens the sign-in page again. Its callback watch now answers the readiness browser's own network proxy, which had failed every page with `net::ERR_INVALID_AUTH_CREDENTIALS` before it loaded. Finish reviewer sign-in sends your session, so creating the handoff link no longer fails with 401.
