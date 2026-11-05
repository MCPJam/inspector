---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Conformance lets a server's OAuth checks be left out of the score. OAuth's checks are one sign-in flow, so they all still run; an unchecked check reads as unscored and does not count toward the score or the verdict. The SDK's `scoreFromOAuthResult` takes `unscoredCheckIds`, and `toConformanceReport` takes `oauthUnscoredCheckIds` for OAuth results, marking those cases `pending`.
