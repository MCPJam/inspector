---
"@mcpjam/inspector": patch
---

Enterprise telemetry privacy is now resolved by the backend and enforced twice. Session replay records in full only after the backend verifies every organization and project in view as non-private; anything it cannot verify, and every navigation until the destination resolves, is recorded masked. Analytics and error tracking start identified by id alone and add name and email only once the backend clears the current account. Every PostHog event is stamped with the context it was captured in, and the `/relay` and `/tlm` proxy re-checks that context with the backend before forwarding: restricted events lose names, IP and GeoIP, URL names and autocapture text, and their replay is masked from an allowlist of rrweb structures, while unknown replay structures are refused. Sentry Replay now blocks links and other URL-bearing elements, and Sentry breadcrumbs, page URLs and performance spans lose console output and names short of full.
