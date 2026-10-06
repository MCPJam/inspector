---
"@mcpjam/inspector": patch
"@mcpjam/sdk": minor
---

A request refused because a feature is not enabled for your organization now says so in a machine-readable way. The answer stays `403 FORBIDDEN`, and `details` now carries `code: "FEATURE_UNAVAILABLE"` and the gated `feature` when the platform names it. The hosted browser answers the same way instead of `422 BROWSER_NOT_AVAILABLE`. The SDK adds `isFeatureUnavailable(error)` to tell that refusal apart from a permission denial.
